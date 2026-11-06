/**
 * The summary of a day and the activity heat map (see ../reports.ts), for administrators and operators only, each behind its own switch in the security options of Studio (both off by default):
 *
 *   summary.daily   GET /api/v1/summary/daily?date=YYYY-MM-DD&lang=xx   the summary of a day, made by ARMOR-SERVER-AI from the alarms the server kept
 *   vision.heatmap  GET /api/v1/vision/heatmap?camera=&format=&scale=  the heat map of a camera, made by ARMOR-VISION (json, png or svg)
 *   vision.heatmap  GET /api/v1/vision/counts  the crossings of the counting lines of each camera, as numbers, counted by ARMOR-VISION
 *
 * With its switch off a route answers 404 to everybody who may ask, whatever the data. A viewer, a wall panel and a service with its own token are refused before anything is read.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { dayOf } from "../day.js";
import { dailySummary, heatmap, heatmapQuery, lineCounts, isSummaryLanguage, Serial, validDate, type ReportAnswer } from "../reports.js";

export function registerReportRoutes(app: Express, context: AppContext): void {
  const { config, securitySettings, alarms, audit, requireOperator, studioUser, runReport, fetchVision, dailyLog } = context;
  const limit = rateLimit({ windowMs: 60_000, limit: () => securitySettings.get("reports.requests_per_minute"), standardHeaders: "draft-8", legacyHeaders: false });
  // Each report has its own line: a summary (a Python process, seconds) must not hold up a heat map (one local request) behind it, and the other way round.
  const summaryQueue = new Serial(() => securitySettings.get("reports.queue_max"));
  const heatmapQueue = new Serial(() => securitySettings.get("reports.queue_max"));
  const timeoutMs = (): number => securitySettings.get("reports.timeout_s") * 1000;

  /** Administrators and operators (a Studio account, or the operator token or session); a viewer is let through GET by the operator rule and is turned away here. */
  const mayAsk = (request: Request, response: Response, what: string): boolean => {
    const user = studioUser(request);
    if (!user || user.role === "admin" || user.role === "operator") return true;
    audit.record({ action: `report.${what}`, outcome: "denied", actor: user.username, detail: user.role });
    response.status(403).json({ error: "only an administrator or an operator can ask for this" });
    return false;
  };

  const send = (response: Response, answer: ReportAnswer): void => {
    response.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    if ("json" in answer) { response.status(answer.status).json(answer.json); return; }
    response.set({ "Content-Type": answer.type, ...(answer.type === "image/svg+xml" ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
    response.status(200).send(answer.bytes);
  };

  app.get("/api/v1/summary/daily", requireOperator, limit, async (request, response) => {
    if (!mayAsk(request, response, "summary_daily")) return;
    if (!securitySettings.get("summary.daily")) return void response.status(404).json({ error: "daily_summary_disabled" });
    const { date: asked, lang } = request.query;
    const date = asked === undefined ? dayOf(Date.now()) : asked;
    if (typeof date !== "string" || !validDate(date)) return void response.status(422).json({ error: "invalid_date" });
    if (lang !== undefined && !isSummaryLanguage(lang)) return void response.status(422).json({ error: "invalid_language" });
    const language = lang ?? config.alertLanguage;
    const answer = await summaryQueue.run(() => dailySummary({ config, run: runReport, alarms: () => alarms.kept(), language, timeoutMs: timeoutMs(), maxBytes: config.summaryMaxBytes, sources: day => ({ logged: dailyLog.events(day), falseAlarmS: securitySettings.get("summary.false_alarm_s") }) }, date, language));
    audit.record({ action: "report.summary_daily", outcome: answer !== "busy" && answer.status === 200 ? "allowed" : "denied", actor: studioUser(request)?.username ?? "operator", target: date });
    send(response, answer === "busy" ? { status: 503, json: { error: "report_busy" } } : answer);
  });

  app.get("/api/v1/vision/heatmap", requireOperator, limit, async (request, response) => {
    if (!mayAsk(request, response, "vision_heatmap")) return;
    if (!securitySettings.get("vision.heatmap")) return void response.status(404).json({ error: "heatmap_disabled" });
    const query = heatmapQuery(request.query);
    if (!query) return void response.status(400).json({ error: "invalid_query" });
    const answer = await heatmapQueue.run(() => heatmap({ url: securitySettings.get("vision.service_url"), remote: securitySettings.get("vision.service_remote"), fetch: fetchVision, timeoutMs: timeoutMs(), token: config.visionServiceToken, maxBytes: config.visionMaxBytes }, query));
    audit.record({ action: "report.vision_heatmap", outcome: answer !== "busy" && answer.status === 200 ? "allowed" : "denied", actor: studioUser(request)?.username ?? "operator", target: query.camera ?? "-" });
    send(response, answer === "busy" ? { status: 503, json: { error: "report_busy" } } : answer);
  });

  // How many times each counting line has been crossed, to the left and to the right, since the service of ARMOR-VISION started (numbers only). It is part of the same report as the heat map and has its switch.
  app.get("/api/v1/vision/counts", requireOperator, limit, async (request, response) => {
    if (!mayAsk(request, response, "vision_counts")) return;
    if (!securitySettings.get("vision.heatmap")) return void response.status(404).json({ error: "heatmap_disabled" });
    if (Object.keys(request.query).length > 0) return void response.status(400).json({ error: "invalid_query" });
    const answer = await heatmapQueue.run(() => lineCounts({ url: securitySettings.get("vision.service_url"), remote: securitySettings.get("vision.service_remote"), fetch: fetchVision, timeoutMs: timeoutMs(), token: config.visionServiceToken, maxBytes: config.visionMaxBytes }));
    audit.record({ action: "report.vision_counts", outcome: answer !== "busy" && answer.status === 200 ? "allowed" : "denied", actor: studioUser(request)?.username ?? "operator", target: "-" });
    send(response, answer === "busy" ? { status: 503, json: { error: "report_busy" } } : answer);
  });
}
