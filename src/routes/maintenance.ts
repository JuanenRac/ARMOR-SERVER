/**
 * Maintenance from Studio: the A.R.M.O.R. programs of this machine against the newest release of each one on GitHub (install them one by one or all, or put the previous one back),
 * the operating system's own updates and its reboot, and a root console for the day nothing else works. Administrators only, every action in the audit trail.
 * Nothing here is privileged: the privileged part is the maintenance agent (ARMOR-DEVOPS), asked over its own Unix socket. The console is a door that is shut twice: the agent
 * has it off unless it was turned on in its environment, and here an administrator must give the password again before the first command and every ten minutes of use.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import type { AdminReply } from "../admin.js";

export const COMPONENTS = ["server", "studio", "network", "ai", "voice", "devops"] as const;
const UNLOCK_MS = 10 * 60_000, FAILURES_ALLOWED = 5, FAILURE_WINDOW_MS = 5 * 60_000;
const JOB_ID = /^[A-Za-z0-9-]{1,40}$/;

const relay = (response: Response, reply: AdminReply) => response.status(reply.status).json(reply.body);

export function registerMaintenanceRoutes(app: Express, context: AppContext): void {
  const { maintenance, audit, requireAdmin, studioUser, users } = context;
  const actor = (request: Request) => studioUser(request)?.username;
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  const unlocked = new Map<string, number>();
  const failures = new Map<string, number[]>();
  const ended = new Set<string>();

  async function ask(response: Response, method: string, path: string, payload?: unknown): Promise<AdminReply | undefined> {
    if (!maintenance) { response.status(503).json({ error: "maintenance_unavailable", reason: "not_configured" }); return undefined; }
    try { return await maintenance.request(method, path, payload); }
    catch { response.status(503).json({ error: "maintenance_unavailable", reason: "not_answering" }); return undefined; }
  }

  app.get("/api/v1/admin/maintenance/status", requireAdmin, async (_request, response) => {
    if (!maintenance) return response.json({ available: false, reason: "not_configured", hint: "install the maintenance agent: ARMOR-DEVOPS scripts/install_cm5.sh --with-maintenance" });
    try { const reply = await maintenance.request("GET", "/v1/console"); return response.json({ available: reply.status === 200, console: reply.body.enabled === true, reason: reply.status === 200 ? "" : "refused" }); }
    catch { return response.json({ available: false, reason: "not_answering" }); }
  });

  // ---- what is installed, against GitHub ----
  app.get("/api/v1/admin/updates", requireAdmin, async (request, response) => {
    const force = request.query.force === "1";
    const reply = await ask(response, "GET", `/v1/overview${force ? "?force=1" : ""}`);
    if (!reply) return;
    if (force) audit.record({ action: "maintenance.check", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request) });
    relay(response, reply);
  });

  app.post("/api/v1/admin/updates", requireAdmin, async (request, response) => {
    const input = body(request);
    const wanted = Array.isArray(input.components) ? input.components.filter((item): item is string => typeof item === "string") : [];
    if (wanted.length === 0 || wanted.length > COMPONENTS.length || wanted.some(item => !(COMPONENTS as readonly string[]).includes(item))) return response.status(422).json({ error: "unknown_component" });
    const reply = await ask(response, "POST", "/v1/updates", { components: [...new Set(wanted)], force: input.force === true });
    if (!reply) return;
    audit.record({ action: "maintenance.update", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: wanted.join(","), detail: input.force === true ? "forced" : undefined });
    relay(response, reply);
  });

  app.post("/api/v1/admin/updates/:id/rollback", requireAdmin, async (request, response) => {
    const id = String(request.params.id);
    if (!(COMPONENTS as readonly string[]).includes(id)) return response.status(404).json({ error: "unknown_component" });
    const reply = await ask(response, "POST", `/v1/updates/${id}/rollback`);
    if (!reply) return;
    audit.record({ action: "maintenance.rollback", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: id });
    relay(response, reply);
  });

  app.delete("/api/v1/admin/updates/history", requireAdmin, async (request, response) => {
    const reply = await ask(response, "POST", "/v1/history/clear", {});
    if (!reply) return;
    audit.record({ action: "maintenance.history.clear", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), detail: reply.status < 300 ? `${String(reply.body.cleared ?? 0)} entries` : undefined });
    relay(response, reply);
  });

  // ---- the operating system ----
  for (const action of ["check", "upgrade", "reboot"] as const) {
    app.post(`/api/v1/admin/system/${action}`, requireAdmin, async (request, response) => {
      const mode = action === "upgrade" && typeof body(request).mode === "string" ? String(body(request).mode) : undefined;
      if (mode !== undefined && !["upgrade", "full", "repair"].includes(mode)) return response.status(422).json({ error: "bad_mode" });
      const reply = await ask(response, "POST", `/v1/system/${action}`, mode === undefined ? undefined : { mode });
      if (!reply) return;
      audit.record({ action: `maintenance.system.${action}`, outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), ...(mode ? { detail: mode } : {}) });
      relay(response, reply);
    });
  }

  app.get("/api/v1/admin/maintenance/jobs/:id", requireAdmin, async (request, response) => {
    const id = String(request.params.id);
    if (!JOB_ID.test(id)) return response.status(404).json({ error: "no_such_job" });
    const since = Math.max(0, Math.floor(Number(request.query.since ?? 0)) || 0);
    const reply = await ask(response, "GET", `/v1/jobs/${id}?since=${since}`);
    if (reply) relay(response, reply);
  });

  // ---- the console ----
  app.get("/api/v1/admin/console", requireAdmin, async (request, response) => {
    const until = unlocked.get(actor(request) ?? "") ?? 0;
    if (!maintenance) return response.json({ available: false, enabled: false, unlocked_until: 0 });
    try { const reply = await maintenance.request("GET", "/v1/console"); return response.json({ available: reply.status === 200, enabled: reply.body.enabled === true, unlocked_until: until > Date.now() ? until : 0 }); }
    catch { return response.json({ available: false, enabled: false, unlocked_until: 0 }); }
  });

  app.post("/api/v1/admin/console/unlock", requireAdmin, async (request, response) => {
    const name = actor(request) ?? "";
    const recent = (failures.get(name) ?? []).filter(at => Date.now() - at < FAILURE_WINDOW_MS);
    if (recent.length >= FAILURES_ALLOWED) {
      audit.record({ action: "console.unlock", outcome: "denied", actor: name, detail: "too many wrong passwords" });
      return response.status(429).json({ error: "too_many_attempts" });
    }
    const password = typeof body(request).password === "string" ? body(request).password as string : "";
    if (!await users.authenticateLater(name, password)) {
      failures.set(name, [...recent, Date.now()]);
      audit.record({ action: "console.unlock", outcome: "denied", actor: name, detail: "wrong password" });
      return response.status(403).json({ error: "wrong_password" });
    }
    failures.delete(name);
    const until = Date.now() + UNLOCK_MS;
    unlocked.set(name, until);
    audit.record({ action: "console.unlock", outcome: "allowed", actor: name });
    return response.json({ unlocked_until: until });
  });

  app.post("/api/v1/admin/console/lock", requireAdmin, (request, response) => {
    unlocked.delete(actor(request) ?? "");
    audit.record({ action: "console.lock", outcome: "allowed", actor: actor(request) });
    response.json({ unlocked_until: 0 });
  });

  const isUnlocked = (request: Request) => (unlocked.get(actor(request) ?? "") ?? 0) > Date.now();

  app.post("/api/v1/admin/console/run", requireAdmin, async (request, response) => {
    if (!isUnlocked(request)) return response.status(403).json({ error: "console_locked" });
    const input = body(request);
    const command = typeof input.command === "string" ? input.command : "";
    if (!command.trim() || command.length > 4000) return response.status(422).json({ error: "invalid_command" });
    const cwd = typeof input.cwd === "string" && input.cwd.startsWith("/") ? input.cwd.slice(0, 400) : "/root";
    const timeout = Math.min(3600, Math.max(1, Number(input.timeout) || 120));
    // Every command is written down before anything else, with who asked and where; what it printed is not (it may hold a secret). It is written before it is sent: an agent that
    // does not answer (a timeout, a broken socket) may have run it as root all the same.
    audit.record({ action: "console.run", outcome: "allowed", actor: actor(request), target: cwd, detail: `requested: ${command.slice(0, 290)}` });
    const reply = await ask(response, "POST", "/v1/console/run", { command, cwd, timeout });
    if (!reply) { audit.record({ action: "console.run", outcome: "failed", actor: actor(request), target: cwd, detail: "the agent did not answer: the command may have run" }); return; }
    audit.record({ action: "console.run", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: cwd, detail: `answered ${reply.status}` });
    if (reply.status < 300) unlocked.set(actor(request) ?? "", Date.now() + UNLOCK_MS);   // using it keeps it open
    relay(response, reply);
  });

  app.get("/api/v1/admin/console/jobs/:id", requireAdmin, async (request, response) => {
    if (!isUnlocked(request)) return response.status(403).json({ error: "console_locked" });
    const id = String(request.params.id);
    if (!JOB_ID.test(id)) return response.status(404).json({ error: "no_such_job" });
    const since = Math.max(0, Math.floor(Number(request.query.since ?? 0)) || 0);
    const reply = await ask(response, "GET", `/v1/console/jobs/${id}?since=${since}`);
    if (!reply) return;
    if (reply.status === 200 && reply.body.state !== "running" && !ended.has(id)) {
      ended.add(id);
      if (ended.size > 500) ended.delete(ended.values().next().value as string);
      audit.record({ action: "console.exit", outcome: reply.body.code === 0 ? "allowed" : "failed", actor: actor(request), target: id, detail: `${String(reply.body.state)} code ${String(reply.body.code)}` });
    }
    relay(response, reply);
  });

  app.post("/api/v1/admin/console/jobs/:id/cancel", requireAdmin, async (request, response) => {
    if (!isUnlocked(request)) return response.status(403).json({ error: "console_locked" });
    const id = String(request.params.id);
    if (!JOB_ID.test(id)) return response.status(404).json({ error: "no_such_job" });
    const reply = await ask(response, "POST", `/v1/console/jobs/${id}/cancel`);
    if (!reply) return;
    audit.record({ action: "console.cancel", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: id });
    relay(response, reply);
  });

  // ---- the way in from outside the house: the VPN (WireGuard) and the dynamic DNS name -----------------------------------------------------------------------------
  // The work is done by the maintenance agent (as root, with two helper scripts); here an administrator asks for it, a new proof of identity is wanted from outside the house, and
  // the audit trail says what was done without a key, a token or a configuration in it. What carries a private key (the configuration of a device) is never cached.
  const PEER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
  const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value) ? value : undefined);
  const pick = (input: Record<string, unknown>, keys: Array<[string, number]>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, max] of keys) { const value = text(input[key], max); if (value !== undefined) out[key] = value; }
    return out;
  };

  app.get("/api/v1/admin/remote", requireAdmin, async (_request, response) => {
    const reply = await ask(response, "GET", "/v1/remote");
    if (!reply) return;
    response.setHeader("Cache-Control", "no-store");
    relay(response, reply);
  });

  app.post("/api/v1/admin/remote/wireguard/setup", requireAdmin, context.requireElevated, async (request, response) => {
    const input = body(request);
    const payload: Record<string, unknown> = pick(input, [["endpoint", 260], ["lan", 20], ["subnet", 20], ["route_lan", 15]]);
    if (typeof input.port === "number" && Number.isInteger(input.port)) payload.port = input.port;
    const reply = await ask(response, "POST", "/v1/remote/wireguard/setup", payload);
    if (!reply) return;
    audit.record({ action: "remote.vpn.setup", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: String(payload.endpoint ?? "") });
    relay(response, reply);
  });

  app.post("/api/v1/admin/remote/wireguard/peers", requireAdmin, context.requireElevated, async (request, response) => {
    const input = body(request);
    const name = typeof input.name === "string" ? input.name : "";
    if (!PEER.test(name)) return response.status(422).json({ error: "bad_name" });
    const reply = await ask(response, "POST", "/v1/remote/wireguard/peers", { name, full_tunnel: input.full_tunnel === true });
    if (!reply) return;
    audit.record({ action: "remote.vpn.peer.add", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: name });
    response.setHeader("Cache-Control", "no-store");
    relay(response, reply);
  });

  app.get("/api/v1/admin/remote/wireguard/peers/:name", requireAdmin, context.requireElevated, async (request, response) => {
    const name = String(request.params.name ?? "");
    if (!PEER.test(name)) return response.status(422).json({ error: "bad_name" });
    const reply = await ask(response, "GET", `/v1/remote/wireguard/peers/${name}`);
    if (!reply) return;
    audit.record({ action: "remote.vpn.peer.show", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: name });
    response.setHeader("Cache-Control", "no-store");
    relay(response, reply);
  });

  app.delete("/api/v1/admin/remote/wireguard/peers/:name", requireAdmin, context.requireElevated, async (request, response) => {
    const name = String(request.params.name ?? "");
    if (!PEER.test(name)) return response.status(422).json({ error: "bad_name" });
    const reply = await ask(response, "POST", `/v1/remote/wireguard/peers/${name}/remove`, {});
    if (!reply) return;
    audit.record({ action: "remote.vpn.peer.remove", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: name });
    relay(response, reply);
  });

  app.post("/api/v1/admin/remote/ddns/setup", requireAdmin, context.requireElevated, async (request, response) => {
    const input = body(request);
    const payload = pick(input, [["provider", 12], ["domain", 63], ["token", 200], ["zone", 32], ["record_name", 253], ["url", 1000]]);
    const reply = await ask(response, "POST", "/v1/remote/ddns/setup", payload);
    if (!reply) return;
    audit.record({ action: "remote.ddns.setup", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: String(payload.provider ?? "") });
    relay(response, reply);
  });

  for (const action of ["update", "remove"] as const) {
    app.post(`/api/v1/admin/remote/ddns/${action}`, requireAdmin, context.requireElevated, async (request, response) => {
      const reply = await ask(response, "POST", `/v1/remote/ddns/${action}`, {});
      if (!reply) return;
      audit.record({ action: `remote.ddns.${action}`, outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request) });
      relay(response, reply);
    });
  }
}
