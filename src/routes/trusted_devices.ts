/**
 * Trusted phones (see ../trusted_devices.ts). Everything but the list and the removal answers 404 until an administrator turns on `client.trusted_devices`.
 *   GET    /api/v1/devices/trust                    the phones of the signed-in person (an administrator may ask for all of them with ?all=1)
 *   POST   /api/v1/devices/trust                    { name, public_key } registers the phone of the signed-in person (outside the house, after proving oneself again)
 *   DELETE /api/v1/devices/trust/{id}               ends a phone: its owner or an administrator (outside the house, after proving oneself again)
 *   POST   /api/v1/devices/trust/challenge          { id } gives a one-time value to sign (no session needed; limited by address)
 *   POST   /api/v1/devices/trust/session            { id, challenge, signature } opens a session of the length client.trusted_session_h when the signature is right
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { AppContext } from "../context.js";
import { TRUSTED_CHALLENGE_MS, TrustedDevices } from "../trusted_devices.js";

export function registerTrustedDeviceRoutes(app: Express, context: AppContext): void {
  const { trustedDevices, securitySettings, studioSessions, studioUser, users, audit, requireElevated, originOfRequest, connections, sightingOf } = context;
  const on: RequestHandler = (_request, response, next) => (securitySettings.get("client.trusted_devices") ? next() : void response.status(404).json({ error: "trusted devices are off", code: "trusted_devices_off" }));
  const signedIn: RequestHandler = (request, response, next) => (studioUser(request) ? next() : void response.status(401).json({ error: "sign in first" }));
  // Whoever has a session is already limited by the general limit of the API; the two steps that need none are limited by address, and the failed tries of the whole server on top.
  const byAddress = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many tries" }, keyGenerator: request => ipKeyGenerator(request.ip ?? "") });
  const everywhere = rateLimit({ windowMs: 60_000, limit: 40, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many tries" }, keyGenerator: () => "all" });
  const agentOf = (request: { header(name: string): string | undefined }): string => (request.header("user-agent") ?? "").replace(/[\r\n]/g, " ").slice(0, 120);

  app.get("/api/v1/devices/trust", signedIn, (request, response) => {
    const user = studioUser(request)!;
    const all = request.query.all === "1" && user.role === "admin";
    const names = new Map(users.list().map(item => [item.id, item.username]));
    return response.json({ enabled: securitySettings.get("client.trusted_devices"), devices: trustedDevices.list(all ? undefined : user.id).map(device => ({ ...TrustedDevices.view(device), username: names.get(device.userId) ?? "" })) });
  });

  app.post("/api/v1/devices/trust", on, signedIn, requireElevated, (request, response) => {
    const user = studioUser(request)!;
    const result = trustedDevices.register(user.id, request.body?.name, request.body?.public_key);
    if (result === "bad_name") return response.status(400).json({ error: "the phone needs a name", code: "invalid_name" });
    if (result === "bad_key") return response.status(400).json({ error: "the key must be an ECDSA P-256 public key (DER, base64)", code: "invalid_key" });
    if (result === "limit") return response.status(409).json({ error: "too many trusted phones: remove one first", code: "too_many_devices" });
    audit.record({ action: "devices.trust.add", outcome: "allowed", actor: user.username, target: result.id, detail: result.name });
    return response.status(201).json(TrustedDevices.view(result));
  });

  app.delete("/api/v1/devices/trust/:id", signedIn, requireElevated, (request, response) => {
    const user = studioUser(request)!;
    const device = trustedDevices.get(String(request.params.id ?? ""));
    if (!device || (device.userId !== user.id && user.role !== "admin")) return response.status(404).json({ error: "no such trusted phone" });
    trustedDevices.remove(device.id);
    audit.record({ action: "devices.trust.remove", outcome: "allowed", actor: user.username, target: device.id, detail: device.name });
    return response.sendStatus(204);
  });

  app.post("/api/v1/devices/trust/challenge", on, everywhere, byAddress, (request, response) => {
    const id = typeof request.body?.id === "string" ? request.body.id : "";
    const challenge = trustedDevices.challenge(id);
    if (!challenge) return response.status(404).json({ error: "no such trusted phone", code: "unknown_device" });
    response.setHeader("Cache-Control", "no-store");
    return response.json({ challenge, expires_in_s: TRUSTED_CHALLENGE_MS / 1000 });
  });

  app.post("/api/v1/devices/trust/session", on, everywhere, byAddress, (request, response) => {
    const id = typeof request.body?.id === "string" ? request.body.id : "";
    const origin = originOfRequest(request), ip = request.ip ?? "";
    const device = trustedDevices.prove(id, request.body?.challenge, request.body?.signature);
    const user = device ? users.get(device.userId) : undefined;
    if (!device || !user) {
      audit.record({ action: "devices.trust.session", outcome: "denied", target: id.slice(0, 24), detail: `${origin} ${ip}` });
      return response.status(401).json({ error: "the phone could not prove itself", code: "bad_proof" });
    }
    connections.login(sightingOf(request, user.username), false);
    const expiresAt = studioSessions.open(response, user.id, { origin, ip, agent: agentOf(request), ttlMs: securitySettings.get("client.trusted_session_h") * 3_600_000 });
    audit.record({ action: "devices.trust.session", outcome: "allowed", actor: user.username, target: device.id, detail: `${origin} ${ip}` });
    return response.status(201).json({ expiresAt, user: { id: user.id, username: user.username, role: user.role } });
  });
}
