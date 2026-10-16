/**
 * The check before arming: what would make the perimeter blind or noisy the moment it is armed. A radar node that does not answer, an alarm panel that is silent or has a zone open, a
 * camera that does not answer, a door or window that is open, an alarm nobody has seen. Each finding says whether it should stop the person (`block`) or only be known (`warn`).
 * It reads state and changes nothing.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { isTriggered, type DeviceKind } from "./devices/catalog.js";

export type PreflightIssue = {
  kind: "node" | "panel" | "zone" | "camera" | "device" | "alarm";
  level: "block" | "warn";
  /** What is wrong, as a code Studio, the phone and the wall panel each put into words. */
  code: "node_offline" | "panel_silent" | "zone_open" | "camera_down" | "opening_open" | "device_offline" | "alarm_unseen";
  id: string;
  /** A second id when it helps (the zone of a panel). */
  detail?: string;
};
export type Preflight = { ready: boolean; checked_at: string; blocking: number; warnings: number; issues: PreflightIssue[] };

export type PreflightInput = {
  nodes: ReadonlyArray<{ node_id: string; online: boolean }>;
  panels: ReadonlyArray<{ node_id: string; stale: boolean; open_zones: readonly string[] }>;
  cameras: ReadonlyArray<{ id: string; status: string }>;
  devices: ReadonlyArray<{ id: string; kind: string; online: boolean; state: Record<string, unknown>; expected_interval_s?: number }>;
  alarms: ReadonlyArray<{ id: string; acknowledged_at?: string; cleared_at?: string; severity: string }>;
  now?: Date;
};

export function buildPreflight(input: PreflightInput): Preflight {
  const issues: PreflightIssue[] = [];
  for (const node of input.nodes) if (!node.online) issues.push({ kind: "node", level: "block", code: "node_offline", id: node.node_id });
  for (const panel of input.panels) {
    if (panel.stale) { issues.push({ kind: "panel", level: "block", code: "panel_silent", id: panel.node_id }); continue; }
    for (const zone of panel.open_zones) issues.push({ kind: "zone", level: "block", code: "zone_open", id: panel.node_id, detail: zone });
  }
  for (const camera of input.cameras) if (camera.status === "offline") issues.push({ kind: "camera", level: "warn", code: "camera_down", id: camera.id });
  for (const device of input.devices) {
    if ((device.kind === "door" || device.kind === "window") && isTriggered(device.kind as DeviceKind, device.state as never)) issues.push({ kind: "device", level: "block", code: "opening_open", id: device.id });
    else if (!device.online && (device.expected_interval_s ?? 0) > 0) issues.push({ kind: "device", level: "warn", code: "device_offline", id: device.id });
  }
  for (const alarm of input.alarms) if (!alarm.acknowledged_at && !alarm.cleared_at) issues.push({ kind: "alarm", level: alarm.severity === "warning" ? "warn" : "block", code: "alarm_unseen", id: alarm.id });
  const blocking = issues.filter(issue => issue.level === "block").length;
  return { ready: blocking === 0, checked_at: (input.now ?? new Date()).toISOString(), blocking, warnings: issues.length - blocking, issues };
}
