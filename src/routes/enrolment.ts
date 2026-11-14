/**
 * The one-use code that sets up an app on a phone from a QR, behind the security option `client.enrolment_code` (off by default: both routes answer 404 as if they did not exist).
 *   POST /api/v1/admin/enrolment-code   an administrator who proved themselves again asks for a code that lives five minutes and works once; the answer is what the QR carries: the code,
 *                                       the address the phones use and the fingerprint (SHA-256) of the public certificate of the local authority of the LAN, when the server has one.
 *   GET  /api/v1/enrolment/{code}       no session: the phone reads the address and the fingerprint once. Nothing secret is in the code or in the answer, and it opens no session:
 *                                       the person still types their user and password. A used, ended or wrong code, and the option off, all answer the same 404; too many tries from one address answer 429.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";

/** How long a code lives and how many are kept at once (a new request over the limit drops the oldest). */
export const ENROLMENT_CODE_TTL_MS = 5 * 60_000;
const MAX_LIVE_CODES = 20;

/** SHA-256 of the public certificate in the file, as 64 lower-case hex characters; null when there is none, it is not a certificate, or the file also holds a private key. */
export function caFingerprint(file: string | null): string | null {
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, "utf8");
    if (/PRIVATE KEY/.test(text) || !/^-----BEGIN CERTIFICATE-----/.test(text.trim())) return null;
    return new crypto.X509Certificate(text).fingerprint256.replace(/:/g, "").toLowerCase();
  } catch { return null; }
}

/** The https address of a request body or header, reduced to scheme, host and port; null when it is not one. */
export function cleanOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch { return null; }
}

export function registerEnrolmentRoutes(app: Express, context: AppContext): void {
  const { audit, requireAdmin, requireElevated, studioUser, securitySettings, config } = context;
  /** code -> the facts it opens and when it ends (memory only: a restart forgets the codes, which only makes a QR go stale). */
  const live = new Map<string, { origin: string; fingerprint: string | null; endsAt: number }>();
  const tries = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many tries" } });
  const prune = (now: number): void => { for (const [code, entry] of live) if (entry.endsAt <= now) live.delete(code); };

  app.post("/api/v1/admin/enrolment-code", requireAdmin, requireElevated, (request, response) => {
    if (!securitySettings.get("client.enrolment_code")) return response.status(404).json({ error: "not found" });
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as { origin?: unknown };
    const origin = body.origin === undefined ? cleanOrigin(`https://${request.get("host") ?? ""}`) : cleanOrigin(body.origin);
    const actor = studioUser(request)?.username ?? "admin";
    if (!origin) {
      audit.record({ action: "enrolment.code", outcome: "denied", actor, detail: "address is not https" });
      return response.status(400).json({ error: "origin must be an https address", code: "invalid_origin" });
    }
    const now = Date.now();
    prune(now);
    while (live.size >= MAX_LIVE_CODES) { const oldest = live.keys().next().value; if (oldest === undefined) break; live.delete(oldest); }
    const code = crypto.randomBytes(24).toString("base64url");
    const fingerprint = caFingerprint(config.lanCaFile);
    live.set(code, { origin, fingerprint, endsAt: now + ENROLMENT_CODE_TTL_MS });
    audit.record({ action: "enrolment.code", outcome: "allowed", actor, detail: "code made" });
    response.setHeader("Cache-Control", "no-store");
    return response.json({ code, expires_at: new Date(now + ENROLMENT_CODE_TTL_MS).toISOString(), origin, ca_fingerprint: fingerprint });
  });

  app.get("/api/v1/enrolment/:code", tries, (request, response) => {
    const notFound = () => response.status(404).json({ error: "not found" });
    if (!securitySettings.get("client.enrolment_code")) return notFound();
    const code = String(request.params.code ?? "");
    const now = Date.now();
    prune(now);
    const entry = /^[A-Za-z0-9_-]{16,64}$/.test(code) ? live.get(code) : undefined;
    if (!entry) { audit.record({ action: "enrolment.read", outcome: "denied", actor: "phone", detail: "unknown, used or ended code" }); return notFound(); }
    live.delete(code);
    audit.record({ action: "enrolment.read", outcome: "allowed", actor: "phone", detail: "code used" });
    response.setHeader("Cache-Control", "no-store");
    return response.json({ origin: entry.origin, ca_fingerprint: entry.fingerprint });
  });
}
