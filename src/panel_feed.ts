/**
 * What the wall panel (ARMOR-HMI) is shown, and the live channel it can listen to instead of asking for it every few seconds.
 *
 * The summary is the small document of `GET /api/v1/panel/summary`: the mode, how many nodes are there, the alarms that need a person and the energy. The channel is a WebSocket,
 * `/api/v1/panel/events`, which sends exactly that document (`{ "type": "summary", "summary": {...} }`) when a socket opens and again whenever something in it changed, and nothing else:
 * a panel that listens gets no more than a panel that asks. It is read-only (the panel arms, disarms and acknowledges through the same routes as before) and it is the administrator's
 * to turn off (`panel.live_events`); a panel then goes back to asking.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AppContext } from "./context.js";
import type { SolarTotals } from "./solar.js";

/** What the wall panel's energy page shows: the power of the panels and of the house, the battery's charge and power, and whether the solar equipment reports at all. Always a few dozen bytes. */
export function energySummary(totals: SolarTotals): { reporting: boolean; pv_w: number; load_w: number; battery_w: number | null; soc_percent: number | null; mode: string | null; inverters: number; batteries: number; stale: number } {
  return {
    reporting: totals.inverters + totals.batteries > totals.stale, pv_w: Math.round(totals.pv_w), load_w: Math.round(totals.load_w),
    battery_w: totals.battery_w === null ? null : Math.round(totals.battery_w), soc_percent: totals.soc_percent === null ? null : Math.round(totals.soc_percent),
    mode: totals.mode, inverters: totals.inverters, batteries: totals.batteries, stale: totals.stale,
  };
}

/** The summary: always a few hundred bytes, whatever the installation holds. The alarms nobody has acknowledged come first, newest first. */
export function buildPanelSummary(context: Pick<AppContext, "store" | "alarms" | "solar">, now: () => number = Date.now): Record<string, unknown> {
  const state = context.store.snapshot(), nodes = Object.values(state.nodes), active = context.alarms.active();
  const order = [...active].sort((a, b) => Number(Boolean(a.acknowledged_at)) - Number(Boolean(b.acknowledged_at)) || b.raised_at.localeCompare(a.raised_at));
  return {
    mode: state.mode, revision: state.revision, time_ms: now(),
    nodes: { online: nodes.filter(node => node.online).length, total: nodes.length },
    energy: energySummary(context.solar.totals()),
    alarms: {
      active: active.length, unacknowledged: active.filter(alarm => !alarm.acknowledged_at).length,
      items: order.slice(0, 6).map(alarm => ({ id: alarm.id, code: alarm.code, severity: alarm.severity, source_type: alarm.source.type, source_id: alarm.source.id.slice(0, 48), raised_at: alarm.raised_at, acknowledged: Boolean(alarm.acknowledged_at) })),
    },
  };
}

/** The part of a WebSocket the feed uses (the `ws` socket has all of it). */
export type PanelSocket = { readyState: number; bufferedAmount: number; send(data: string): void; terminate(): void };
const OPEN = 1;
/** A panel that is too far behind (it stopped reading) is dropped rather than made to wait in memory: what it would get next is only newer. */
export const MAX_PANEL_BUFFERED_BYTES = 64 * 1024;
/** A panel that hears nothing for a few of these knows the channel is gone: the summary is sent again, unchanged, at least this often, and the frame says how often (`heartbeat_ms`). */
export const PANEL_HEARTBEAT_MS = 5000;

export type PanelFeed = {
  /** Sends the summary to every open socket when something in it changed since the last time (the clock in it does not count). `force` sends it anyway. */
  push(force?: boolean): void;
  /** Sends the current summary to one socket (a panel that has just connected). */
  hello(socket: PanelSocket): void;
};

export function createPanelFeed(summary: () => Record<string, unknown>, sockets: () => Iterable<PanelSocket>): PanelFeed {
  let last = "";
  const line = (document: Record<string, unknown>): string => JSON.stringify({ type: "summary", heartbeat_ms: PANEL_HEARTBEAT_MS, summary: document });
  const sendTo = (socket: PanelSocket, text: string): void => {
    if (socket.readyState !== OPEN) return;
    if (socket.bufferedAmount > MAX_PANEL_BUFFERED_BYTES) { socket.terminate(); return; }
    try { socket.send(text); } catch { socket.terminate(); }
  };
  return {
    push(force = false): void {
      let any = false;
      for (const socket of sockets()) { any = true; break; }
      if (!any) return;   // nobody listens: nothing is built
      const document = summary();
      const { time_ms: _clock, ...stable } = document;
      const key = JSON.stringify(stable);
      if (!force && key === last) return;
      last = key;
      const text = line(document);
      for (const socket of sockets()) sendTo(socket, text);
    },
    hello(socket: PanelSocket): void { sendTo(socket, line(summary())); },
  };
}
