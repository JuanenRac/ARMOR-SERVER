/**
 * The numbers of the server in the text form that Prometheus (and anything that reads that form) scrapes: the machine, the nodes, the alarms and what the broker handed over,
 * per topic. Read only, and no name, address, token or message text is ever in it: only counts and sizes. The route is off until an administrator turns on the option
 * `metrics.prometheus` in Studio, and it answers only to the bearer token the server was given in its environment (ARMOR_METRICS_TOKEN or ARMOR_METRICS_TOKEN_FILE).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IngestEntry } from "./ingest_log.js";
import type { MetricsSample } from "./system_metrics.js";
import type { VisionCountRow } from "./vision_counters.js";

export type MetricsInput = {
  sample: MetricsSample;
  nodes: Array<{ online: boolean }>;
  activeAlarms: number;
  ingest: readonly IngestEntry[];
  /** The events of the vision service counted so far; without it the page has no vision series. */
  vision?: readonly VisionCountRow[];
  version: string;
  startedMs: number;
  nowMs: number;
};

/** A label value: backslash, quote and new line escaped as the exposition format asks, and cut short. */
const label = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").slice(0, 80);
const number = (value: number | null | undefined): string => (typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "NaN");

/** The whole page. */
export function renderPrometheus(input: MetricsInput): string {
  const lines: string[] = [];
  const family = (name: string, help: string, type: "gauge" | "counter", rows: Array<[string, number | null]>): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of rows) lines.push(`${name}${labels} ${number(value)}`);
  };
  const { sample } = input;
  family("armor_build_info", "The version of the server (the value is always 1).", "gauge", [[`{version="${label(input.version)}"}`, 1]]);
  family("armor_uptime_seconds", "Seconds since the server started.", "gauge", [["", Math.max(0, Math.round((input.nowMs - input.startedMs) / 1000))]]);
  family("armor_nodes", "The nodes the server knows, by whether they are online.", "gauge", [
    ['{state="online"}', input.nodes.filter(node => node.online).length], ['{state="offline"}', input.nodes.filter(node => !node.online).length],
  ]);
  family("armor_alarms_active", "The alarms that are active now.", "gauge", [["", input.activeAlarms]]);
  family("armor_cpu_percent", "Processor use in percent (NaN until the second sample).", "gauge", [["", sample.cpu.percent]]);
  family("armor_memory_used_bytes", "Memory in use.", "gauge", [["", sample.memory.used]]);
  family("armor_memory_total_bytes", "Memory installed.", "gauge", [["", sample.memory.total]]);
  family("armor_temperature_celsius", "Temperatures the machine reports.", "gauge", sample.temperatures.map(item => [`{zone="${label(item.name)}"}`, item.celsius] as [string, number]));
  family("armor_disk_used_bytes", "Space used on each disk.", "gauge", sample.disks.map(item => [`{mount="${label(item.mount)}"}`, item.used] as [string, number]));
  family("armor_disk_total_bytes", "Size of each disk.", "gauge", sample.disks.map(item => [`{mount="${label(item.mount)}"}`, item.total] as [string, number]));
  family("armor_ingest_accepted_total", "Messages taken, per topic.", "counter", input.ingest.map(item => [`{topic="${label(item.topic)}"}`, item.accepted] as [string, number]));
  family("armor_ingest_rejected_total", "Messages refused, per topic.", "counter", input.ingest.map(item => [`{topic="${label(item.topic)}"}`, item.rejected] as [string, number]));
  if (input.vision) family("armor_vision_events_total", "Events of the vision service taken, by kind and by what was done with them.", "counter", input.vision.map(item => [`{kind="${label(item.kind)}",outcome="${label(item.outcome)}"}`, item.count] as [string, number]));
  return `${lines.join("\n")}\n`;
}

/** Whether the Authorization header carries the metrics token (constant time; no token set: never). */
export function metricsTokenOk(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  const given = createHash("sha256").update(match[1]!).digest(), wanted = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, wanted);
}
