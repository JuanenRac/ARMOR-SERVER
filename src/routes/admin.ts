/**
 * Administration from Studio: the A.R.M.O.R. services (state, start, stop, restart), their settings files, the accounts of the MQTT broker, and
 * the one-step adoption of a field node (its broker account made and written into the node). Administrators only, every action in the audit trail.
 * Nothing here is privileged: the privileged part is the admin agent (ARMOR-DEVOPS), which this file asks over a Unix socket and which can do only a closed list of things.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import { maskEnv, unmaskEnv, type AdminReply } from "../admin.js";

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
const BROKER_HOST = /^[A-Za-z0-9.-]{1,253}$/;

/** What the agent said, handed on to the console; a refusal keeps its own status and code. */
const relay = (response: Response, reply: AdminReply, shape?: (body: Record<string, unknown>) => Record<string, unknown>) =>
  response.status(reply.status).json(reply.status < 300 && shape ? shape(reply.body) : reply.body);

export function registerAdminRoutes(app: Express, context: AppContext): void {
  const { admin, audit, requireAdmin, studioUser, config } = context;
  const actor = (request: Request) => studioUser(request)?.username;
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});

  /** Ask the agent; if it is not configured or not answering, say so in the one way the console understands. */
  async function ask(response: Response, method: string, path: string, payload?: unknown): Promise<AdminReply | undefined> {
    if (!admin) { response.status(503).json({ error: "admin_unavailable", reason: "not_configured" }); return undefined; }
    try { return await admin.request(method, path, payload); }
    catch { response.status(503).json({ error: "admin_unavailable", reason: "not_answering" }); return undefined; }
  }

  app.get("/api/v1/admin/status", requireAdmin, async (_request, response) => {
    if (!admin) return response.json({ available: false, reason: "not_configured", hint: "install the admin agent: ARMOR-DEVOPS scripts/install_cm5.sh --with-admin" });
    try { const reply = await admin.request("GET", "/v1/services"); return response.json({ available: reply.status === 200, reason: reply.status === 200 ? "" : "refused" }); }
    catch { return response.json({ available: false, reason: "not_answering" }); }
  });

  app.get("/api/v1/admin/services", requireAdmin, async (_request, response) => {
    const reply = await ask(response, "GET", "/v1/services");
    if (reply) relay(response, reply);
  });

  app.post("/api/v1/admin/services/:id/:action", requireAdmin, async (request, response) => {
    const id = String(request.params.id), action = String(request.params.action);
    const reply = await ask(response, "POST", `/v1/services/${encodeURIComponent(id)}/${encodeURIComponent(action)}`);
    if (!reply) return;
    audit.record({ action: "admin.service", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: id, detail: action });
    relay(response, reply);
  });

  app.get("/api/v1/admin/files", requireAdmin, async (_request, response) => {
    const reply = await ask(response, "GET", "/v1/files");
    if (reply) relay(response, reply);
  });

  app.get("/api/v1/admin/files/:id", requireAdmin, async (request, response) => {
    const reply = await ask(response, "GET", `/v1/files/${encodeURIComponent(String(request.params.id))}`);
    if (!reply) return;
    relay(response, reply, data => (data.format === "env" && typeof data.content === "string" ? { ...data, content: maskEnv(data.content), masked: true } : data));
  });

  app.put("/api/v1/admin/files/:id", requireAdmin, async (request, response) => {
    const id = String(request.params.id), input = body(request);
    if (typeof input.content !== "string") return response.status(422).json({ error: "invalid_content" });
    let content = input.content;
    if (content.includes(`=********`)) {
      // A masked secret stays as it was: put the real value back before the file goes to the agent.
      const current = await ask(response, "GET", `/v1/files/${encodeURIComponent(id)}`);
      if (!current) return;
      const given = unmaskEnv(content, typeof current.body.content === "string" ? current.body.content : "");
      if ("missing" in given) return response.status(422).json({ error: "masked_value_without_original", key: given.missing });
      content = given.content;
    }
    const reply = await ask(response, "PUT", `/v1/files/${encodeURIComponent(id)}`, { content, restart: input.restart === true, expect_mtime: typeof input.expect_mtime === "number" ? input.expect_mtime : undefined });
    if (!reply) return;
    audit.record({ action: "admin.file", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: id, detail: input.restart === true ? "restart" : "saved" });
    relay(response, reply);
  });

  app.get("/api/v1/admin/mqtt/accounts", requireAdmin, async (_request, response) => {
    const reply = await ask(response, "GET", "/v1/mqtt/accounts");
    if (reply) relay(response, reply);
  });

  app.post("/api/v1/admin/mqtt/accounts", requireAdmin, async (request, response) => {
    const input = body(request);
    const reply = await ask(response, "POST", "/v1/mqtt/accounts", { role: input.role, name: input.name });
    if (!reply) return;
    audit.record({ action: "admin.mqtt.add", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: String(reply.body.user ?? `${String(input.role)}-${String(input.name)}`) });
    response.setHeader("Cache-Control", "no-store");
    relay(response, reply);
  });

  app.delete("/api/v1/admin/mqtt/accounts/:user", requireAdmin, async (request, response) => {
    const user = String(request.params.user);
    const reply = await ask(response, "DELETE", `/v1/mqtt/accounts/${encodeURIComponent(user)}`);
    if (!reply) return;
    audit.record({ action: "admin.mqtt.remove", outcome: reply.status < 300 ? "allowed" : "failed", actor: actor(request), target: user });
    relay(response, reply);
  });

  /**
   * Adopt a node in one step: make (or renew) its broker account and write the broker's address and that account into the node itself, with the
   * node's own administrator login, which is used once and never kept. If the node cannot be reached or refuses, the account stays and its password
   * is returned so it can be typed into the node by hand.
   */
  app.post("/api/v1/admin/nodes/provision", requireAdmin, async (request, response) => {
    const input = body(request);
    const nodeId = String(input.node_id ?? ""), address = String(input.address ?? ""), brokerHost = String(input.broker_host ?? "");
    if (!NODE_ID.test(nodeId)) return response.status(422).json({ error: "invalid_node_id" });
    // A node's panel is on the local network, on port 80. (A different port, and the loopback address, are for tests only: they need ARMOR_ADMIN_NODE_PORT.)
    const testPort = process.env.ARMOR_ADMIN_NODE_PORT ? Number(process.env.ARMOR_ADMIN_NODE_PORT) : 0;
    if (!PRIVATE_V4.test(address) && !(testPort > 0 && address === "127.0.0.1")) return response.status(422).json({ error: "invalid_address" });
    if (!BROKER_HOST.test(brokerHost)) return response.status(422).json({ error: "invalid_broker_host" });
    const user = typeof input.panel_user === "string" ? input.panel_user : "", password = typeof input.panel_password === "string" ? input.panel_password : "";
    const brokerPort = typeof input.broker_port === "number" && input.broker_port >= 1024 && input.broker_port <= 65535 ? input.broker_port : 18883;

    const accounts = await ask(response, "GET", "/v1/mqtt/accounts");
    if (!accounts) return;
    const wanted = `field-node-${nodeId}`;
    const existing = Array.isArray(accounts.body.accounts) && (accounts.body.accounts as Array<{ user?: string }>).some(item => item.user === wanted);
    if (existing) {
      const removed = await ask(response, "DELETE", `/v1/mqtt/accounts/${wanted}`);
      if (!removed) return;
      if (removed.status >= 300) return relay(response, removed);
    }
    const created = await ask(response, "POST", "/v1/mqtt/accounts", { role: "node", name: nodeId });
    if (!created) return;
    if (created.status >= 300) return relay(response, created);
    const account = { user: String(created.body.user), password: String(created.body.password) };
    audit.record({ action: "admin.node.provision", outcome: "allowed", actor: actor(request), target: nodeId, detail: existing ? "account renewed" : "account made" });
    response.setHeader("Cache-Control", "no-store");

    const done = (written: boolean, why = "") => response.json({ ok: true, written, why, broker: { uri: `mqtt://${brokerHost}:${brokerPort}`, username: account.user, password: account.password } });
    if (!user || !password) return done(false, "no_panel_login");
    try {
      const base = `http://${address}${testPort > 0 ? `:${testPort}` : ""}`;
      const signal = AbortSignal.timeout(8000);
      const login = await fetch(`${base}/api/v1/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, password }), signal });
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      if (!login.ok || !cookie) return done(false, login.status === 401 ? "panel_login_refused" : "panel_login_failed");
      const saved = await fetch(`${base}/api/v1/config`, {
        method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ mqtt: { enabled: true, uri: `mqtt://${brokerHost}:${brokerPort}`, username: account.user, password: account.password } }), signal,
      });
      if (!saved.ok) return done(false, "panel_config_refused");
      await fetch(`${base}/api/v1/reboot`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}", signal }).catch(() => undefined);
      audit.record({ action: "admin.node.configure", outcome: "allowed", actor: actor(request), target: nodeId, detail: `${address}` });
      return done(true);
    } catch {
      return done(false, "panel_not_reachable");
    }
  });

  void config;
}
