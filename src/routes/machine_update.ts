/**
 * Updating the machine's programs from Studio or the phone, in two steps, through the maintenance agent and the engine of the updater: the first call is a PREVIEW (what is installed
 * against the newest release; nothing changes) and hands out a plan; the second is the APPLY, which wants that plan, the name of the project typed again, a recent proof of identity
 * (`requireElevated`) and the administrator's one-time code, which is passed on to the agent and never kept. Off unless ARMOR_CM5_UPDATE=1. Administrators only, every call in the audit
 * trail, at most one apply every five minutes, and the agent forces the signature policy `require`: what is not signed is never put in place. Nothing here runs a command.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import type { AdminReply } from "../admin.js";

const PROJECT = /^ARMOR-[A-Z0-9][A-Z0-9-]{0,39}$/;
const PLAN = /^[0-9a-f]{24}$/;
const CODE = /^[0-9]{6}$/;
const JOB_ID = /^[A-Za-z0-9-]{1,40}$/;
export const APPLY_MIN_INTERVAL_MS = 5 * 60_000;

export function registerMachineUpdateRoutes(app: Express, context: AppContext): void {
  const { maintenance, audit, requireAdmin, studioUser, config } = context;
  const actor = (request: Request) => studioUser(request)?.username;
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  let lastApply = 0;

  const relay = (response: Response, reply: AdminReply) => { response.setHeader("Cache-Control", "no-store"); return response.status(reply.status).json(reply.body); };

  /** Asks the agent; answers the caller itself when the switch is off, the agent is not configured or it does not answer. */
  async function ask(response: Response, method: string, path: string, payload?: unknown, headers?: Record<string, string>): Promise<AdminReply | undefined> {
    if (!config.cm5Update) { response.status(403).json({ error: "machine_update_disabled" }); return undefined; }
    if (!maintenance) { response.status(503).json({ error: "maintenance_unavailable", reason: "not_configured" }); return undefined; }
    try { return await maintenance.request(method, path, payload, headers); }
    catch { response.status(503).json({ error: "maintenance_unavailable", reason: "not_answering" }); return undefined; }
  }

  // Whether the switch is on here and on the agent's side, and the programs that can be updated. Reading it changes nothing.
  app.get("/api/v1/admin/machine-update", requireAdmin, async (_request, response) => {
    if (!config.cm5Update) return response.json({ enabled: false, reason: "switched_off" });
    if (!maintenance) return response.json({ enabled: false, reason: "not_configured" });
    try {
      const reply = await maintenance.request("GET", "/v1/updater");
      return response.json({ enabled: reply.status === 200 && reply.body.enabled === true, available: reply.body.available === true, require_signed: reply.body.require_signed === true,
        projects: Array.isArray(reply.body.projects) ? reply.body.projects.filter((item): item is string => typeof item === "string") : [], reason: reply.status === 200 ? (reply.body.enabled === true ? "" : "agent_switched_off") : "refused" });
    } catch { return response.json({ enabled: false, reason: "not_answering" }); }
  });

  // Step one: the preview. It changes nothing; if the program is outdated the answer carries a plan_id that is good once and for five minutes.
  app.post("/api/v1/admin/machine-update/preview", requireAdmin, async (request, response) => {
    const project = body(request).project;
    if (typeof project !== "string" || !PROJECT.test(project)) return response.status(422).json({ error: "unknown_project" });
    const reply = await ask(response, "POST", "/v1/updater/preview", { project });
    if (!reply) return;
    audit.record({ action: "machine_update.preview", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: project, detail: reply.status < 300 ? `${String(reply.body.local_version)} -> ${String(reply.body.github_version)}` : `answered ${reply.status}` });
    relay(response, reply);
  });

  // Step two: the apply. The project is typed again as the confirmation (`confirm`), the plan is the one the preview handed out and the code is the administrator's current one.
  app.post("/api/v1/admin/machine-update/apply", requireAdmin, context.requireElevated, async (request, response) => {
    const input = body(request);
    const project = input.project, plan = input.plan_id, confirm = input.confirm, code = input.totp;
    if (typeof project !== "string" || !PROJECT.test(project)) return response.status(422).json({ error: "unknown_project" });
    if (typeof plan !== "string" || !PLAN.test(plan)) return response.status(422).json({ error: "bad_plan" });
    if (confirm !== project) return response.status(422).json({ error: "confirmation_mismatch" });
    if (code !== undefined && (typeof code !== "string" || !CODE.test(code))) return response.status(422).json({ error: "bad_code" });
    if (config.cm5Update && Date.now() - lastApply < APPLY_MIN_INTERVAL_MS) {
      audit.record({ action: "machine_update.apply", outcome: "denied", actor: actor(request), target: project, detail: "too soon after the last one" });
      return response.status(429).json({ error: "too_soon" });
    }
    // Written down before it is sent: an agent that does not answer may have started it all the same.
    if (config.cm5Update && maintenance) audit.record({ action: "machine_update.apply", outcome: "allowed", actor: actor(request), target: project, detail: "requested" });
    const reply = await ask(response, "POST", "/v1/updater/apply", { project, plan_id: plan }, typeof code === "string" ? { "X-Armor-Maint-Totp": code } : undefined);
    if (!reply) return;
    if (reply.status < 300) lastApply = Date.now();
    audit.record({ action: "machine_update.apply", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: project, detail: `answered ${reply.status}${reply.status >= 300 ? ` ${String(reply.body.error ?? "")}`.slice(0, 60) : ""}` });
    relay(response, reply);
  });

  // The progress of the job the apply started (the agent's own job list; the log never holds a secret).
  app.get("/api/v1/admin/machine-update/jobs/:id", requireAdmin, async (request, response) => {
    const id = String(request.params.id);
    if (!JOB_ID.test(id)) return response.status(404).json({ error: "no_such_job" });
    const since = Math.max(0, Math.floor(Number(request.query.since ?? 0)) || 0);
    const reply = await ask(response, "GET", `/v1/jobs/${id}?since=${since}`);
    if (reply) relay(response, reply);
  });
}
