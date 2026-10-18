/**
 * Sessions: the Studio sign-in (human login) and the operator-token exchange
 * used by service automation. Both hand out an HttpOnly cookie, never a body token.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { AppContext } from "../context.js";
import { randomBytes } from "node:crypto";
import { hasBearer } from "../http/auth.js";

/** A sign-in that passed the password and waits for the second factor: two minutes, five tries. */
type Challenge = { userId: string; username: string; role: string; origin: "local" | "remote"; ip: string; agent: string; until: number; tries: number };
const CHALLENGE_MS = 120_000;

export function registerSessionRoutes(app: Express, context: AppContext): void {
  const { config, audit, connections, sightingOf, studioSessions, operatorSessions, requireOperator, users, studioUser, totp, originOfRequest, notifier, store } = context;
  /** The places a person has already signed in from outside the house (kept while the server runs): a new one is told to the places the alarms go to. */
  const knownPlaces = new Set<string>();
  const challenges = new Map<string, Challenge>();
  const agentOf = (request: { header(name: string): string | undefined }): string => (request.header("user-agent") ?? "").replace(/[\r\n]/g, " ").slice(0, 120);
  const open = (response: Parameters<typeof studioSessions.open>[0], user: { id: string; username: string; role: string }, origin: "local" | "remote", ip: string, agent: string, request: Parameters<typeof sightingOf>[0], twoFactor: boolean) => {
    connections.login(sightingOf(request, user.username), twoFactor);
    const expiresAt = studioSessions.open(response, user.id, { origin, ip, agent, ...(origin === "remote" ? { ttlMs: config.remoteSessionTtlMs } : {}) });
    audit.record({ action: "studio.login", outcome: "allowed", actor: user.username, detail: `${origin} ${ip}` });
    if (origin === "remote" && config.loginAlerts && !knownPlaces.has(`${user.id}|${ip}`)) {
      if (knownPlaces.size >= 500) knownPlaces.delete(knownPlaces.values().next().value!);
      knownPlaces.add(`${user.id}|${ip}`);
      notifier.send({ service: "armor-server", event: "login.remote", at: new Date().toISOString(), mode: store.snapshot().mode, login_user: user.username, login_from: ip });
    }
    return { expiresAt, user: { id: user.id, username: user.username, role: user.role } };
  };
  // Twelve tries per person and place, so that someone trying passwords for one account (or a phone with an old password in a loop) does not lock everybody else out, and a wider
  // limit per place on top, so that trying many accounts from one place is slowed too.
  const loginLimit = rateLimit({
    windowMs: 15 * 60_000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many Studio login attempts" },
    keyGenerator: request => `${ipKeyGenerator(request.ip ?? "")}|${typeof request.body?.username === "string" ? request.body.username.trim().toLowerCase().slice(0, 60) : ""}`,
  });
  const placeLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many Studio login attempts" }, keyGenerator: request => ipKeyGenerator(request.ip ?? "") });

  app.get("/api/v1/studio/session", (request, response) => {
    const user = studioUser(request);
    return response.json({ authenticated: Boolean(user), ...(user ? { user: { id: user.id, username: user.username, role: user.role } } : {}) });
  });

  app.post("/api/v1/studio/session", placeLimit, loginLimit, async (request, response) => {
    const username = typeof request.body?.username === "string" ? request.body.username : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    // The same work is done whether or not the user exists, so the response time never reveals which value was wrong.
    const user = await users.authenticateLater(username, password);
    const origin = originOfRequest(request), ip = request.ip ?? "";
    if (!user) {
      connections.refused(sightingOf(request, username.trim().slice(0, 60)), "login_failed", users.list().some(item => item.username.toLowerCase() === username.trim().toLowerCase()));
      audit.record({ action: "studio.login", outcome: "denied", actor: username.slice(0, 40), detail: `${origin} ${ip}` });
      return response.sendStatus(401);
    }
    // The second factor: asked whenever the person turned it on; the policy can also demand it from outside the house (or everywhere), and then a person who never set it up has to do so first.
    const has = totp.enabled(user.id);
    const demanded = config.totpPolicy === "always" || (config.totpPolicy === "remote" && origin === "remote");
    if (demanded && !has) {
      audit.record({ action: "studio.login", outcome: "denied", actor: user.username, detail: `${origin} ${ip}, the second factor is required and not set up` });
      return response.status(403).json({ error: "the second factor is required here: set it up from inside the house first", code: "totp_setup_required" });
    }
    if (has) {
      for (const [key, item] of challenges) if (item.until <= Date.now()) challenges.delete(key);
      if (challenges.size >= 200) challenges.delete(challenges.keys().next().value!);
      const challenge = randomBytes(24).toString("base64url");
      challenges.set(challenge, { userId: user.id, username: user.username, role: user.role, origin, ip, agent: agentOf(request), until: Date.now() + CHALLENGE_MS, tries: 0 });
      return response.status(200).json({ totp_required: true, challenge, expires_in_s: CHALLENGE_MS / 1000 });
    }
    return response.status(201).json(open(response, user, origin, ip, agentOf(request), request, false));
  });

  /** The second step of the sign-in: the challenge of the first step and a code of the app (or a recovery code). */
  app.post("/api/v1/studio/session/totp", placeLimit, (request, response) => {
    const challenge = typeof request.body?.challenge === "string" ? request.body.challenge : "";
    const code = typeof request.body?.code === "string" ? request.body.code : "";
    const pending = challenges.get(challenge);
    if (!pending || pending.until <= Date.now()) { challenges.delete(challenge); return response.status(401).json({ error: "the sign-in expired: start again", code: "challenge_expired" }); }
    const wait = totp.waitFor(pending.userId);
    if (wait > 0) return response.status(429).set("Retry-After", String(wait)).json({ error: "too many wrong codes", code: "totp_locked", retry_after_s: wait });
    pending.tries += 1;
    if (!totp.verify(pending.userId, code)) {
      connections.refused(sightingOf(request, pending.username), "second_factor_failed", true);
      audit.record({ action: "studio.totp", outcome: "denied", actor: pending.username, detail: `${pending.origin} ${request.ip ?? ""}` });
      if (pending.tries >= 5) challenges.delete(challenge);
      return response.status(401).json({ error: "that code is not right", code: "bad_code" });
    }
    challenges.delete(challenge);
    return response.status(201).json(open(response, { id: pending.userId, username: pending.username, role: pending.role }, originOfRequest(request), request.ip ?? "", agentOf(request), request, true));
  });

  // ---- the sessions of the person, and the proof of identity that critical actions ask for -----------------------------------------------------------
  const requireSession: import("express").RequestHandler = (request, response, next) => (studioUser(request) ? next() : void response.status(401).json({ error: "sign in first" }));

  app.get("/api/v1/studio/sessions", requireSession, (request, response) => {
    const user = studioUser(request)!;
    return response.json({ sessions: studioSessions.list(user.id, request) });
  });

  app.delete("/api/v1/studio/sessions/:id", requireSession, (request, response) => {
    const user = studioUser(request)!;
    const ended = studioSessions.revokeId(user.id, String(request.params.id ?? ""));
    if (ended) audit.record({ action: "studio.session.end", outcome: "allowed", actor: user.username, detail: `${originOfRequest(request)} ${request.ip ?? ""}` });
    return ended ? response.sendStatus(204) : response.status(404).json({ error: "no such session" });
  });

  app.post("/api/v1/studio/sessions/end-others", requireSession, (request, response) => {
    const user = studioUser(request)!;
    studioSessions.revokeUser(user.id, request);
    audit.record({ action: "studio.session.end", outcome: "allowed", actor: user.username, detail: "all the others" });
    return response.sendStatus(204);
  });

  /** A new proof (the password, or a code of the second factor) makes critical actions possible for a few minutes on this session. */
  app.post("/api/v1/studio/elevate", requireSession, placeLimit, async (request, response) => {
    const user = studioUser(request)!;
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const code = typeof request.body?.code === "string" ? request.body.code : "";
    let good = false;
    if (code && totp.enabled(user.id)) { if (totp.waitFor(user.id) > 0) return response.status(429).json({ error: "too many wrong codes", code: "totp_locked" }); good = totp.verify(user.id, code); }
    else if (password) good = !(totp.enabled(user.id) && originOfRequest(request) === "remote") && Boolean(await users.authenticateLater(user.username, password));   // with the second factor on, outside the house, the password alone is not a new proof
    audit.record({ action: "studio.elevate", outcome: good ? "allowed" : "denied", actor: user.username, detail: `${originOfRequest(request)} ${request.ip ?? ""}` });
    if (!good) return response.status(401).json({ error: "that is not right", code: "bad_proof" });
    studioSessions.elevate(request, Date.now() + config.elevationMs);
    return response.json({ elevated_for_s: Math.round(config.elevationMs / 1000) });
  });

  // ---- the second factor of the person ---------------------------------------------------------------------------------------------------------------
  app.get("/api/v1/studio/totp", requireSession, (request, response) => {
    const user = studioUser(request)!;
    return response.json({ enabled: totp.enabled(user.id), recovery_left: totp.recoveryLeft(user.id), policy: config.totpPolicy });
  });

  app.post("/api/v1/studio/totp/setup", requireSession, placeLimit, async (request, response) => {
    const user = studioUser(request)!;
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!(await users.authenticateLater(user.username, password))) return response.status(401).json({ error: "the password is not right", code: "bad_proof" });
    if (totp.enabled(user.id)) return response.status(409).json({ error: "the second factor is already on: turn it off first", code: "already_enabled" });
    return response.json(totp.begin(user.id, user.username));
  });

  app.post("/api/v1/studio/totp/enable", requireSession, placeLimit, (request, response) => {
    const user = studioUser(request)!;
    const codes = totp.confirm(user.id, typeof request.body?.code === "string" ? request.body.code.trim() : "");
    if (!codes) return response.status(401).json({ error: "that code is not right", code: "bad_code" });
    studioSessions.revokeUser(user.id, request);   // the other sessions signed in without it
    audit.record({ action: "studio.totp.enable", outcome: "allowed", actor: user.username });
    return response.json({ enabled: true, recovery_codes: codes });
  });

  app.delete("/api/v1/studio/totp", requireSession, placeLimit, async (request, response) => {
    const user = studioUser(request)!;
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!(await users.authenticateLater(user.username, password))) return response.status(401).json({ error: "the password is not right", code: "bad_proof" });
    totp.disable(user.id);
    studioSessions.revokeUser(user.id, request);
    audit.record({ action: "studio.totp.disable", outcome: "allowed", actor: user.username });
    return response.sendStatus(204);
  });

  /** An administrator turns off the second factor of somebody who lost the phone and the recovery codes (and, from outside the house, proves themselves again). */
  app.delete("/api/v1/users/:id/totp", context.requireAdmin, context.requireElevated, (request, response) => {
    const id = String(request.params.id ?? "");
    if (!users.get(id)) return response.status(404).json({ error: "no such user" });
    totp.disable(id);
    studioSessions.revokeUser(id);
    audit.record({ action: "users.totp.reset", outcome: "allowed", actor: studioUser(request)?.username, target: users.get(id)?.username });
    return response.sendStatus(204);
  });

  /** What the server sees of this request, for checking a remote set-up from a phone on mobile data. */
  app.get("/api/v1/remote/check", context.requireAdmin, (request, response) => response.json({
    ip: request.ip ?? "", origin: originOfRequest(request), session_origin: studioSessions.originOf(request) ?? null, protocol: request.protocol, forwarded_for: request.header("x-forwarded-for") ?? null,
    cookie_secure: config.cookieSecure, trust_proxy: config.trustProxy, totp_policy: config.totpPolicy, totp_enabled: totp.enabled(studioUser(request)!.id),
    remote_session_ttl_s: Math.round(config.remoteSessionTtlMs / 1000), remote_idle_s: Math.round(config.remoteIdleMs / 1000), elevation_s: Math.round(config.elevationMs / 1000),
  }));

  app.delete("/api/v1/studio/session", (request, response) => {
    studioSessions.close(request, response);
    return response.sendStatus(204);
  });

  app.post("/api/v1/operator/session", (request, response) => {
    if (!hasBearer(request, config.operatorToken)) {
      audit.record({ action: "operator.session", outcome: "denied" });
      return response.sendStatus(401);
    }
    const expiresAt = operatorSessions.open(response);
    audit.record({ action: "operator.session", outcome: "allowed" });
    return response.status(201).json({ expiresAt });
  });

  app.delete("/api/v1/operator/session", requireOperator, (request, response) => {
    operatorSessions.close(request, response);
    return response.sendStatus(204);
  });
}
