/**
 * Two reports that the Python projects of the family make and this server hands to administrators and operators, each behind its own security option (both off by default):
 *
 *   summary.daily   GET /api/v1/summary/daily   the events of one day turned into counts, serious alarms, patterns and a text in one of the eight languages (ARMOR-SERVER-AI)
 *   vision.heatmap  GET /api/v1/vision/heatmap  the count of activity per cell of a grid laid over a camera's scene (ARMOR-VISION)
 *
 * Neither project listens on a port: each is run as a command (`python -m armor_server_ai.cli --daily-summary ...`, `python -m armor_vision heatmap-route ...`), one at a time, with a time limit,
 * a size limit, an environment that holds nothing but what Python needs (never the tokens, keys or passwords of this server) and arguments that are never read by a shell. What a command
 * says on its error output is never passed on (it can name a path), and what it prints is checked before it leaves: the summary must have exactly the keys of a report, and a map that says it
 * holds a picture is refused. Anything that is not understood is a 502, never a partial answer.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Alarm } from "./alarms.js";
import type { ArmorConfig } from "./config.js";
import { dayOf, secondOfDay } from "./day.js";

export const SUMMARY_LANGUAGES = ["en", "es", "de", "fr", "it", "ja", "zh", "pt"] as const;
export type SummaryLanguage = typeof SUMMARY_LANGUAGES[number];
export const isSummaryLanguage = (value: unknown): value is SummaryLanguage => typeof value === "string" && (SUMMARY_LANGUAGES as readonly string[]).includes(value);

/** What a command gave back. `code` is -1 when it could not be started or ran out of time. */
export type ReportResult = { code: number; stdout: Buffer; stderr: string };
export type ReportRun = { program: string; args: string[]; env: Record<string, string>; cwd: string; timeoutMs: number; maxBytes: number };
export type RunReport = (run: ReportRun) => Promise<ReportResult>;

export const runReportCommand: RunReport = run => new Promise(resolve => {
  execFile(run.program, run.args, { env: run.env, cwd: run.cwd, timeout: run.timeoutMs, maxBuffer: run.maxBytes, encoding: "buffer", windowsHide: true, shell: false }, (error, stdout, stderr) => {
    if (!error) return resolve({ code: 0, stdout, stderr: stderr.toString("utf8") });
    const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
    resolve({ code, stdout: code === 0 ? stdout : Buffer.alloc(0), stderr: stderr.toString("utf8") });
  });
});

/** The answer of a report: a status, and either a JSON body or bytes with their type. */
export type ReportAnswer = { status: number; json: unknown } | { status: 200; type: string; bytes: Buffer };

const fail = (status: number, error: string): ReportAnswer => ({ status, json: { error } });

/** The environment of a command: what Python needs to start and nothing of this server's (no token, key or password), and where its code is. */
export function commandEnv(pythonPath: string): Record<string, string> {
  const env: Record<string, string> = { PYTHONPATH: pythonPath, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}

/** One report at a time, and only a few waiting: a burst of requests does not become a burst of Python processes. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();
  #waiting = 0;
  constructor(private readonly limit = 3) {}
  async run<T>(task: () => Promise<T>): Promise<T | "busy"> {
    if (this.#waiting >= this.limit) return "busy";
    this.#waiting++;
    const turn = this.#tail.then(task, task);
    this.#tail = turn.catch(() => undefined);
    try { return await turn; } finally { this.#waiting--; }
  }
}

// ------------------------------------------------------------------ the summary of a day

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const SEVERITY: Record<string, string> = { critical: "critical", high: "high", warning: "medium" };
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a calendar date written YYYY-MM-DD that is a real day (from the year 2000). */
export function validDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The events of one day for the summary, from the alarms the server kept: one `alarm` event for each alarm raised that day (in the time zone of the installation) whose code is a plain
 * identifier. The silent alarms are not here, and neither is the free text or the detail of an alarm: only its code, severity, zone and node. Oldest first.
 */
export function dailyEvents(alarms: Alarm[], date: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const alarm of alarms) {
    if (alarm.silent) continue;
    const at = Date.parse(alarm.raised_at);
    if (!Number.isFinite(at) || dayOf(at) !== date || !IDENTIFIER.test(alarm.code)) continue;
    const detail = alarm.detail ?? {};
    const zone = typeof detail.zone === "string" && IDENTIFIER.test(detail.zone) ? detail.zone : undefined;
    const node = typeof detail.node === "string" && IDENTIFIER.test(detail.node) ? detail.node : alarm.source.type === "node" && IDENTIFIER.test(alarm.source.id) ? alarm.source.id : undefined;
    events.push({ t_s: secondOfDay(at), type: "alarm", code: alarm.code, severity: SEVERITY[alarm.severity] ?? "medium", ...(zone ? { zone } : {}), ...(node ? { node } : {}) });
  }
  return events.sort((a, b) => (a.t_s as number) - (b.t_s as number));
}

const REPORT_KEYS = ["findings", "summary", "text"];

export type DailyDeps = { config: ArmorConfig; run: RunReport; alarms: () => Alarm[]; language: SummaryLanguage };

/** The summary of `date` in `language`, or the reason it cannot be made. */
export async function dailySummary(deps: DailyDeps, date: string, language: SummaryLanguage): Promise<ReportAnswer> {
  const { python, dailySummaryAiDir, dailySummaryConfig } = deps.config.reports;
  const source = dailySummaryAiDir ? path.join(dailySummaryAiDir, "src") : "";
  if (!dailySummaryAiDir || !dailySummaryConfig || !fs.existsSync(path.join(source, "armor_server_ai", "cli.py")) || !fs.statSync(dailySummaryConfig, { throwIfNoEntry: false })?.isFile()) return fail(503, "daily_summary_not_configured");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "armor-summary-"));
  try {
    const file = path.join(folder, "day.jsonl");
    fs.writeFileSync(file, dailyEvents(deps.alarms(), date).map(event => JSON.stringify(event)).join("\n"), { encoding: "utf8", mode: 0o600 });
    const result = await deps.run({ program: python, args: ["-m", "armor_server_ai.cli", "--daily-summary", file, "--summary-config", dailySummaryConfig, "--json", "--lang", language], env: commandEnv(source), cwd: folder, timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
    if (result.code === 2 && /is off/.test(result.stderr)) return fail(503, "daily_summary_off_in_settings");
    if (result.code !== 0) return fail(502, "daily_summary_failed");
    let report: Record<string, unknown>;
    try { report = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>; } catch { return fail(502, "daily_summary_failed"); }
    const keys = typeof report === "object" && report !== null && !Array.isArray(report) ? Object.keys(report).sort() : [];
    const known = keys.every(key => REPORT_KEYS.includes(key) || key === "ai_note");
    if (!known || !REPORT_KEYS.every(key => keys.includes(key)) || typeof report.text !== "string" || !Array.isArray(report.findings) || typeof report.summary !== "object" || report.summary === null) return fail(502, "daily_summary_failed");
    return { status: 200, json: { date, language, summary: report.summary, findings: report.findings, text: report.text, ...(typeof report.ai_note === "string" ? { ai_note: report.ai_note } : {}) } };
  } catch {
    return fail(502, "daily_summary_failed");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the heat map

export const HEATMAP_FORMATS = ["json", "png", "svg"] as const;
const CAMERA = /^[A-Za-z0-9._-]{1,80}$/;
const TYPES: Record<string, string> = { json: "application/json", png: "image/png", svg: "image/svg+xml" };

/** The query of the heat map, checked: only camera, format and scale, each a plain value. Null when something else is in it. */
export function heatmapQuery(query: Record<string, unknown>): { camera?: string; format: string; scale: string } | null {
  if (Object.keys(query).some(key => !["camera", "format", "scale"].includes(key))) return null;
  const { camera, format = "json", scale = "16" } = query;
  if (camera !== undefined && (typeof camera !== "string" || !CAMERA.test(camera))) return null;
  if (typeof format !== "string" || !(HEATMAP_FORMATS as readonly string[]).includes(format)) return null;
  if (typeof scale !== "string" || !/^\d{1,2}$/.test(scale) || Number(scale) < 1 || Number(scale) > 64) return null;
  return { ...(camera !== undefined ? { camera } : {}), format, scale };
}

export type HeatmapDeps = { config: ArmorConfig; run: RunReport };

/** The heat map the query asks for, or the reason it cannot be given. */
export async function heatmap(deps: HeatmapDeps, query: { camera?: string; format: string; scale: string }): Promise<ReportAnswer> {
  const { python, visionDir, visionActivityConfig, visionConfig, visionDetections } = deps.config.reports;
  const source = visionDir ? path.join(visionDir, "src") : "";
  const isFile = (file: string): boolean => Boolean(file) && Boolean(fs.statSync(file, { throwIfNoEntry: false })?.isFile());
  if (!visionDir || !fs.existsSync(path.join(source, "armor_vision", "heatmap_service.py")) || !isFile(visionActivityConfig) || !visionDetections || (visionConfig && !isFile(visionConfig))) return fail(503, "heatmap_not_configured");
  if (!isFile(visionDetections)) return fail(503, "heatmap_no_data");
  const args = ["-m", "armor_vision", "heatmap-route", "--activity-config", visionActivityConfig, "--detections-file", visionDetections, "--format", query.format, "--scale", query.scale,
    ...(query.camera ? ["--camera", query.camera] : []), ...(visionConfig ? ["--config", visionConfig] : [])];
  const result = await deps.run({ program: python, args, env: commandEnv(source), cwd: os.tmpdir(), timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024 });
  if (result.code !== 0) return fail(502, "heatmap_failed");
  let answer: { status?: unknown; content_type?: unknown; body_base64?: unknown };
  try { answer = JSON.parse(result.stdout.toString("utf8")) as typeof answer; } catch { return fail(502, "heatmap_failed"); }
  if (typeof answer.status !== "number" || typeof answer.body_base64 !== "string" || typeof answer.content_type !== "string") return fail(502, "heatmap_failed");
  const body = Buffer.from(answer.body_base64, "base64");
  if (answer.status === 400) return fail(400, "invalid_query");
  if (answer.status === 404) return fail(404, body.toString("utf8").startsWith("unknown camera") ? "unknown_camera" : "heatmap_pipeline_off");
  if (answer.status !== 200 || answer.content_type !== TYPES[query.format]) return fail(502, "heatmap_failed");
  if (query.format === "json") {
    // positions only: a map that does not say so, or that is not the shape of a map, is not passed on
    try {
      const map = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      if (map.contains_images !== false || map.schema !== "armor.vision.heatmap/v1" || typeof map.camera_id !== "string" || !CAMERA.test(map.camera_id) || !Array.isArray(map.weights) || !Array.isArray(map.normalized)) return fail(502, "heatmap_failed");
      return { status: 200, json: map };
    } catch { return fail(502, "heatmap_failed"); }
  }
  if (query.format === "png" && !body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return fail(502, "heatmap_failed");
  if (query.format === "svg" && !body.subarray(0, 512).toString("utf8").includes("<svg")) return fail(502, "heatmap_failed");
  return { status: 200, type: TYPES[query.format], bytes: body };
}
