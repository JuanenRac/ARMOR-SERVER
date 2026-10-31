/**
 * Choosing an arming mode on the server (away, home, night) also asks the alarm panels to arm with the profile that goes with it: away arms the profile `away`, home arms `stay` and
 * night arms `night` (the profiles of arm_profiles.ts, which travel inside the arm command). It is OFF unless an administrator turns on the setting `alarm.mode_panel_sync`; off, the
 * modes decide only what the server defends, exactly as before.
 *
 * What it promises, and what it does not:
 *   - The mode of the server is never held back by a panel: the server defends what the mode says the moment it is chosen. What a panel did is told apart, in `panel_sync`:
 *     `pending` (asked, no answer yet), `confirmed` (every panel answered accepted), `failed` (a panel refused, was silent, or could not be asked) or `none` (no panel is known).
 *     Only an answer that says accepted is a confirmation; a command that was sent, or a node that was merely asked, is pending.
 *   - Who may do it is who may change the mode (an arm needs no PIN, as arming never did); the panel commands themselves stay behind their own gates (ARMOR_ALARM_COMMANDS=1, the
 *     node's own `server.commands`, the broker list), so a refusal there is a failed panel, never a bypass.
 *   - Disarming the server does not disarm a panel (that needs a PIN and is a separate decision): the report is cleared and the panel keeps what it has.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AuditLog } from "./audit.js";
import type { ArmProfile } from "./arm_profiles.js";
import { AlarmCommandError, type AlarmRecord } from "./alarm_commands.js";
import type { ArmedMode } from "./arming_modes.js";

/** The profile each server mode arms on a panel. Away and stay are reserved profiles (they always exist); night may have been removed by the owner. */
export const MODE_PROFILE: Readonly<Record<ArmedMode, string>> = Object.freeze({ away: "away", home: "stay", night: "night" });

export type PanelStatus = "pending" | "confirmed" | "refused" | "timeout" | "unavailable";
export type PanelEntry = { node_id: string; status: PanelStatus; command_id?: string; /** What the node refused with, or the code of the reason the command could not be sent. */ reason?: string };
export type SyncStatus = "none" | "pending" | "confirmed" | "failed";
export type PanelSync = { mode: ArmedMode; profile: string; status: SyncStatus; by: string; started_at: string; settled_at?: string; nodes: PanelEntry[] };

export type ModePanelSyncOptions = {
  /** The setting alarm.mode_panel_sync. */
  enabled: () => boolean;
  /** The alarm panels the server knows. */
  panels: () => string[];
  profile: (id: string) => ArmProfile | undefined;
  /** Ask one panel to arm with a profile (AlarmCommands.request); it throws an AlarmCommandError when the command must not be sent. */
  arm: (node: string, base: "away" | "stay", actor: string, profile: ArmProfile) => { command_id: string };
  audit: AuditLog;
  now?: () => number;
  /** The report changed: the state the clients read is sent again. */
  changed?: () => void;
};

const summarize = (nodes: PanelEntry[]): SyncStatus => {
  if (nodes.length === 0) return "none";
  if (nodes.some(node => node.status === "pending")) return "pending";
  return nodes.every(node => node.status === "confirmed") ? "confirmed" : "failed";
};

export class ModePanelSync {
  #state: PanelSync | undefined;
  readonly #o: ModePanelSyncOptions;
  readonly #now: () => number;

  constructor(options: ModePanelSyncOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean { return this.#o.enabled(); }

  /** What the panels did about the mode in force; nothing while the setting is off or the system is disarmed. */
  view(): PanelSync | undefined {
    return this.enabled && this.#state ? structuredClone(this.#state) : undefined;
  }

  /** The system was disarmed: the report is over (a panel is not disarmed from here). */
  clear(): void { if (this.#state) { this.#state = undefined; this.#told(); } }

  #told(): void { try { this.#o.changed?.(); } catch { /* the report stands */ } }

  /**
   * The mode `mode` was chosen. A choice that changes nothing (`noop`) asks again only if the last try did not end well, so that choosing the same mode again is how a failure is retried
   * and a confirmed one is never repeated.
   */
  sync(mode: ArmedMode, by: string, noop = false): void {
    if (!this.enabled) { this.#state = undefined; return; }
    const last = this.#state;
    if (noop && last && last.mode === mode && (last.status === "confirmed" || last.status === "pending" || last.status === "none")) return;
    const at = new Date(this.#now()).toISOString();
    const id = MODE_PROFILE[mode];
    const profile = this.#o.profile(id);
    const nodes: PanelEntry[] = [];
    for (const node of this.#o.panels()) {
      if (!profile) { nodes.push({ node_id: node, status: "unavailable", reason: "unknown_profile" }); continue; }
      try {
        nodes.push({ node_id: node, status: "pending", command_id: this.#o.arm(node, profile.base, by, profile).command_id });
      } catch (error) {
        nodes.push({ node_id: node, status: "unavailable", reason: error instanceof AlarmCommandError ? error.code : "internal_error" });
      }
    }
    this.#state = { mode, profile: id, status: summarize(nodes), by: by.slice(0, 60), started_at: at, ...(summarize(nodes) === "pending" ? {} : { settled_at: at }), nodes };
    this.#audit(this.#state, "asked");
    this.#told();
  }

  /** A command to a panel ended (AlarmCommands.onSettled): the entry that waited for it is confirmed, refused or silent. Any other command is none of ours. */
  settled(record: AlarmRecord): void {
    const state = this.#state;
    const entry = state?.nodes.find(node => node.command_id === record.command_id && node.status === "pending");
    if (!state || !entry) return;
    entry.status = record.accepted ? "confirmed" : record.refusal === "timeout" ? "timeout" : "refused";
    if (!record.accepted) entry.reason = record.refusal;
    state.status = summarize(state.nodes);
    if (state.status !== "pending") { state.settled_at = new Date(this.#now()).toISOString(); this.#audit(state, "ended"); }
    this.#told();
  }

  #audit(state: PanelSync, when: "asked" | "ended"): void {
    if (when === "asked" && state.status === "pending") {
      this.#o.audit.record({ action: "control.mode_panel", outcome: "allowed", actor: state.by, detail: `${state.mode} -> profile ${state.profile}: asked ${state.nodes.length} panel(s)` });
      return;
    }
    const failed = state.nodes.filter(node => node.status !== "confirmed" && node.status !== "pending").map(node => `${node.node_id} ${node.status}${node.reason ? ` (${node.reason})` : ""}`);
    const outcome = state.status === "confirmed" || state.status === "none" ? "allowed" : state.nodes.some(node => node.status === "timeout") ? "failed" : "denied";
    this.#o.audit.record({ action: "control.mode_panel", outcome, actor: state.by, detail: `${state.mode} -> profile ${state.profile}: ${state.status}${failed.length ? `; ${failed.join(", ")}` : ""}`.slice(0, 240) });
  }
}
