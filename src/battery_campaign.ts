/**
 * A firmware campaign on a stack of Pylontech batteries: one module at a time, with the console cable moved to each one, as the maker's tool does it. The server only keeps the list and the
 * order; every step is an ordinary battery operation (battery_write.ts) with all its locks: `check` arms a firmware update for exactly the serial number of the current module (a console
 * with another battery answers serial_mismatch and nothing happens), `execute` confirms it with the serial typed again. A module that fails, a doubtful chip or an image that does not fit
 * stops the campaign; nothing forces it. The campaign is kept in a file so that it can be taken up later. Nothing here has run against a real battery.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { BatteryOpsError, validNode, validSerial } from "./battery_ops.js";
import type { BatteryOperation, BatteryWriteService } from "./battery_write.js";
import { JsonFile } from "./history.js";
import type { SolarStore } from "./solar.js";

export type CampaignState = "active" | "stopped" | "return_cable" | "done" | "cancelled";
export type ModuleStatus = "pending" | "checking" | "ready" | "updating" | "done" | "failed";
export type CampaignModule = {
  number: number; serial: string; model: string; board: string; chip: "older" | "newer" | "unknown"; version?: string; version_after?: string;
  status: ModuleStatus; operation_id?: string; code?: string; resume?: boolean;
};
export type Campaign = {
  id: string; node: string; port: number; device: string; state: CampaignState; current: number; stop_reason?: string; modules: CampaignModule[];
  image: { board: string; version: string; sha256: string; size: number }; actor: string; created_at: string; updated_at: string;
};

export type CampaignOptions = {
  batteryWrite: BatteryWriteService; solar: SolarStore; audit: AuditLog; file?: string; now?: () => number; random?: () => string; keep?: number;
};

/** The models the maker's update table has a rule for. */
const MODELS = new Set(["US2000C", "US3000C", "UP5000", "US5000"]);
/** Refusals of a check that say the module or the image is wrong: the campaign stops, nothing forces it. */
const STOPPING = new Set(["chip_unknown", "image_mismatch", "unsupported_model", "unknown_model", "unknown_firmware", "serial_unreadable"]);

/** The board name the image of this module must carry, or undefined when there is no rule (then nothing may be sent). */
export function expectedBoard(model: string, chip: string, imageVersion: string): string | undefined {
  if (!MODELS.has(model) || (chip !== "older" && chip !== "newer")) return undefined;
  if (model === "US5000") return chip === "older" ? "US5000" : Number(imageVersion.split(".")[0]) < 2 ? "E32000C_NF4" : "US2000C_NF4";
  return chip === "newer" ? "US2000C_NF4" : "US2000C";
}

/** Why a module cannot be in a campaign with this image, or "". */
export function moduleProblem(module: Pick<CampaignModule, "serial" | "model" | "chip">, image: { board: string; version: string }): string {
  if (!validSerial(module.serial) || !/[0-9]/.test(module.serial)) return "serial_unreadable";
  if (!MODELS.has(module.model)) return "unsupported_model";
  const wanted = expectedBoard(module.model, module.chip, image.version);
  if (!wanted) return "chip_unknown";
  return wanted === image.board ? "" : "image_mismatch";
}

export class BatteryCampaignService {
  readonly #o: CampaignOptions & { now: () => number; random: () => string; keep: number };
  readonly #campaigns = new Map<string, Campaign>();
  readonly #images = new Map<string, string>();   // campaign -> the id of the image the server keeps (memory only, like the image)
  readonly #file?: JsonFile<{ schema: 1; campaigns: Campaign[] }>;

  constructor(options: CampaignOptions) {
    this.#o = { ...options, now: options.now ?? (() => Date.now()), random: options.random ?? (() => randomBytes(8).toString("hex")), keep: options.keep ?? 20 };
    if (options.file) {
      this.#file = new JsonFile(options.file);
      const stored = this.#file.read();
      if (stored && Array.isArray(stored.campaigns)) {
        for (const item of stored.campaigns.slice(-this.#o.keep)) if (typeof item?.id === "string" && Array.isArray(item.modules)) this.#campaigns.set(item.id, item);
      }
    }
  }

  list(): Campaign[] {
    for (const campaign of this.#campaigns.values()) this.#sync(campaign);
    return [...this.#campaigns.values()].reverse().map(item => structuredClone(item));
  }

  create(actor: string, input: { node: unknown; port: unknown; device: unknown; image_id: unknown }): Campaign {
    this.#requireEnabled(actor);
    const { node, port, device, image_id: imageId } = input;
    if (!validNode(node) || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 10 || typeof device !== "string" || typeof imageId !== "string") {
      return this.#deny(actor, "invalid_request", "a node, a port from 1 to 10, its battery and a kept image are required", 400);
    }
    const image = this.#o.batteryWrite.imageInfo(imageId);
    if (!image) return this.#deny(actor, "image_missing", "keep the firmware image first (it is kept for an hour)", 409);
    if (this.list().some(item => item.node === node && item.port === port && (item.state === "active" || item.state === "stopped" || item.state === "return_cable"))) {
      return this.#deny(actor, "busy", "there is already a campaign on that port", 409);
    }
    const view = this.#o.solar.list().find(item => item.node_id === node && item.device === device && item.kind === "battery" && !item.example && !item.stale);
    const stack = view && view.reading.kind === "battery" ? view.reading.stack.filter(item => item.present) : [];
    if (stack.length === 0) return this.#deny(actor, "unknown_node", "no module list of that battery: connect the cable to the first battery of the stack and wait for its readings", 404);
    const modules: CampaignModule[] = stack.map(item => ({
      number: item.n, serial: item.serial ?? "", model: item.model ?? "", board: item.board ?? "", chip: item.chip ?? "unknown", ...(item.soft_version ? { version: item.soft_version } : {}), status: "pending" as const,
    }));
    const problems = modules.map(item => ({ number: item.number, problem: moduleProblem(item, image) })).filter(item => item.problem);
    if (new Set(modules.map(item => item.serial)).size !== modules.length) problems.push({ number: 0, problem: "serial_repeated" });
    if (problems.length > 0) return this.#deny(actor, "campaign_blocked", `nothing is forced: ${problems.map(item => `module ${item.number} ${item.problem}`).join(", ")}`, 409);
    const now = new Date(this.#o.now()).toISOString();
    const campaign: Campaign = { id: this.#o.random(), node, port, device, state: "active", current: 0, modules, image: { board: image.board, version: image.version, sha256: image.sha256, size: image.size }, actor, created_at: now, updated_at: now };
    this.#campaigns.set(campaign.id, campaign);
    this.#images.set(campaign.id, imageId);
    while (this.#campaigns.size > this.#o.keep) this.#campaigns.delete(this.#campaigns.keys().next().value as string);
    this.#record(actor, campaign, `started with ${modules.length} modules, ${image.board} ${image.version}`);
    return structuredClone(campaign);
  }

  /** The cable is on the current module: arm its update. */
  check(actor: string, id: string, imageId?: unknown): Campaign {
    this.#requireEnabled(actor);
    const campaign = this.#find(id);
    const module = campaign.modules[campaign.current];
    if (campaign.state !== "active" || !module || (module.status !== "pending" && module.status !== "ready")) return this.#deny(actor, "campaign_state", "there is no module waiting to be checked", 409);
    const kept = typeof imageId === "string" ? imageId : this.#images.get(id);
    const image = kept ? this.#o.batteryWrite.imageInfo(kept) : undefined;
    if (!kept || !image || image.sha256 !== campaign.image.sha256) return this.#deny(actor, "image_missing", "keep the same firmware image again", 409);
    this.#images.set(id, kept);
    const operation = this.#o.batteryWrite.arm(actor, { node: campaign.node, port: campaign.port, op: "firmware_update", params: { image_id: kept, ...(module.resume ? { resume: true } : {}) }, serial: module.serial });
    module.status = "checking";
    module.operation_id = operation.id;
    delete module.code;
    this.#record(actor, campaign, `checking module ${module.number}`);
    return structuredClone(campaign);
  }

  execute(actor: string, id: string, serial: unknown): Campaign {
    this.#requireEnabled(actor);
    const campaign = this.#find(id);
    const module = campaign.modules[campaign.current];
    if (campaign.state !== "active" || !module || module.status !== "ready" || !module.operation_id) return this.#deny(actor, "campaign_state", "check the module first", 409);
    if (serial !== module.serial) return this.#deny(actor, "serial_mismatch", "that is not the serial number of this module", 400);
    this.#o.batteryWrite.execute(actor, module.operation_id, serial);
    module.status = "updating";
    this.#record(actor, campaign, `updating module ${module.number}`);
    return structuredClone(campaign);
  }

  retry(actor: string, id: string): Campaign {
    this.#requireEnabled(actor);
    const campaign = this.#find(id);
    const module = campaign.modules[campaign.current];
    if (campaign.state !== "stopped" || !module) return this.#deny(actor, "campaign_state", "only a stopped campaign is taken up again", 409);
    // a transfer that did not end well leaves the battery in its bootloader: only the same image is tried again there
    if ((module.code ?? "").startsWith("firmware:") || module.code === "bootloader") module.resume = true;
    else if (module.code === "nothing_to_resume") delete module.resume;
    module.status = "pending";
    delete module.operation_id;
    campaign.state = "active";
    delete campaign.stop_reason;
    this.#record(actor, campaign, `taken up again at module ${module.number}`);
    return structuredClone(campaign);
  }

  cancel(actor: string, id: string): Campaign {
    const campaign = this.#find(id);
    const module = campaign.modules[campaign.current];
    if (campaign.state === "done" || campaign.state === "cancelled") return this.#deny(actor, "campaign_state", "that campaign is over", 409);
    if (module?.status === "updating") return this.#deny(actor, "busy", "a module is being written: it is not cut", 409);
    if (module?.operation_id && (module.status === "checking" || module.status === "ready")) this.#o.batteryWrite.cancel(actor, module.operation_id);
    campaign.state = "cancelled";
    this.#record(actor, campaign, "given up");
    return structuredClone(campaign);
  }

  /** The cable is back on the first battery of the stack. */
  finish(actor: string, id: string): Campaign {
    const campaign = this.#find(id);
    if (campaign.state !== "return_cable") return this.#deny(actor, "campaign_state", "the campaign has not reached its last module", 409);
    campaign.state = "done";
    this.#record(actor, campaign, "finished, cable returned");
    return structuredClone(campaign);
  }

  // ---- bookkeeping -------------------------------------------------------------------------------------------------------------------------

  /** Brings the current module up to date with its battery operation. */
  #sync(campaign: Campaign): void {
    if (campaign.state !== "active") return;
    const module = campaign.modules[campaign.current];
    if (!module || !module.operation_id || module.status === "pending" || module.status === "done" || module.status === "failed") return;
    this.#o.batteryWrite.sweep();
    const operation: BatteryOperation | undefined = this.#o.batteryWrite.get(module.operation_id);
    const before = `${module.status} ${module.code ?? ""}`;
    if (module.status === "updating") {
      if (!operation) this.#stop(campaign, module, "operation_lost");
      else if (operation.stage === "done" && operation.outcome === "ok") {
        module.status = "done";
        module.version_after = `V${campaign.image.version}`;
        delete module.code;
        delete module.resume;
        campaign.current += 1;
        if (campaign.current >= campaign.modules.length) campaign.state = "return_cable";
      } else if (operation.stage === "done" || operation.stage === "rejected" || operation.stage === "lost" || operation.stage === "expired" || operation.stage === "withdrawn") {
        this.#stop(campaign, module, operation.code || operation.refusal || operation.stage);
      }
    } else if (!operation || operation.stage === "lost" || operation.stage === "expired" || operation.stage === "withdrawn") {
      // nothing has been written: the module waits to be checked again
      module.status = "pending";
      module.code = operation?.code || operation?.stage || "operation_lost";
    } else if (operation.stage === "rejected") {
      const why = operation.code === "bootloader" || operation.code === "nothing_to_resume" ? operation.code : operation.refusal ?? "rejected";
      if (why === "bootloader" || why === "nothing_to_resume" || STOPPING.has(why)) this.#stop(campaign, module, why);
      else { module.status = "pending"; module.code = why; }
    } else if (operation.stage === "armed") {
      const seen = operation.battery;
      if (!module.resume && seen && (seen.serial !== module.serial || (seen.model ?? module.model) !== module.model || (seen.board ?? module.board) !== module.board)) this.#stop(campaign, module, "module_differs");
      else module.status = "ready";
    }
    if (before !== `${module.status} ${module.code ?? ""}`) this.#record(campaign.actor, campaign, `module ${module.number}: ${module.status}${module.code ? ` ${module.code}` : ""}`);
  }

  #stop(campaign: Campaign, module: CampaignModule, code: string): void {
    module.status = "failed";
    module.code = code;
    campaign.state = "stopped";
    campaign.stop_reason = code;
  }

  #find(id: string): Campaign {
    const campaign = this.#campaigns.get(id);
    if (!campaign) throw new BatteryOpsError("unknown_campaign", "no such campaign", 404);
    this.#sync(campaign);
    return campaign;
  }

  #requireEnabled(actor: string): void {
    if (!this.#o.batteryWrite.enabled) this.#deny(actor, "battery_write_disabled", "writing to batteries is not turned on in this server", 403);
  }

  #deny(actor: string, code: string, message: string, status: number): never {
    this.#o.audit.record({ action: "battery.campaign", outcome: "denied", actor, detail: `${code}: ${message}`.slice(0, 240) });
    throw new BatteryOpsError(code, message, status);
  }

  #record(actor: string, campaign: Campaign, what: string): void {
    campaign.updated_at = new Date(this.#o.now()).toISOString();
    this.#o.audit.record({ action: "battery.campaign", outcome: campaign.state === "stopped" ? "failed" : "allowed", actor, target: `${campaign.node}/${campaign.port}`, detail: `${campaign.id}: ${what}`.slice(0, 240) });
    if (!this.#file) return;
    try { this.#file.write({ schema: 1, campaigns: [...this.#campaigns.values()] }); } catch { /* it is also in memory and in the audit trail */ }
  }
}
