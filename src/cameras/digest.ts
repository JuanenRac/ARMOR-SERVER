/**
 * HTTP/RTSP Digest authentication (RFC 7616, also RFC 2617 clients): MD5 and
 * SHA-256, with or without qop=auth, cnonce and nonce-count.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, randomBytes } from "node:crypto";

export type DigestChallenge = { realm: string; nonce: string; opaque?: string; qop?: string; algorithm: "MD5" | "SHA-256"; stale: boolean };

const parameter = (header: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|[\\s,])${name}=(?:"([^"]*)"|([^\\s,]+))`, "i").exec(header);
  return match ? (match[1] ?? match[2]) : undefined;
};

/** Parse a `WWW-Authenticate: Digest ...` header; null when it is not a usable Digest challenge. */
export function parseDigestChallenge(header: string | undefined): DigestChallenge | null {
  if (!header || !/^\s*Digest\b/i.test(header)) return null;
  const realm = parameter(header, "realm");
  const nonce = parameter(header, "nonce");
  if (!realm || !nonce) return null;
  const algorithm = (parameter(header, "algorithm") ?? "MD5").toUpperCase();
  if (algorithm !== "MD5" && algorithm !== "SHA-256") return null;
  // qop may offer several values ("auth,auth-int"); only "auth" is implemented.
  const offered = (parameter(header, "qop") ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (offered.length && !offered.includes("auth")) return null; // only qop=auth is implemented
  const qop = offered.includes("auth") ? "auth" : undefined;
  return { realm, nonce, opaque: parameter(header, "opaque"), qop, algorithm: algorithm as "MD5" | "SHA-256", stale: /stale=true/i.test(header) };
}

const hash = (algorithm: DigestChallenge["algorithm"], value: string): string =>
  createHash(algorithm === "SHA-256" ? "sha256" : "md5").update(value).digest("hex");

export type DigestOptions = { username: string; password: string; method: string; uri: string; nonceCount?: number; cnonce?: string };

/** Build the `Authorization: Digest ...` header for one request. */
export function digestAuthorization(challenge: DigestChallenge, options: DigestOptions): string {
  const { username, password, method, uri } = options;
  const ha1 = hash(challenge.algorithm, `${username}:${challenge.realm}:${password}`);
  const ha2 = hash(challenge.algorithm, `${method}:${uri}`);
  const quote = (value: string) => value.replace(/["\\]/g, "");
  const parts = [`username="${quote(username)}"`, `realm="${quote(challenge.realm)}"`, `nonce="${quote(challenge.nonce)}"`, `uri="${uri}"`];
  let response: string;
  if (challenge.qop === "auth") {
    const nc = (options.nonceCount ?? 1).toString(16).padStart(8, "0");
    const cnonce = options.cnonce ?? randomBytes(8).toString("hex");
    response = hash(challenge.algorithm, `${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = hash(challenge.algorithm, `${ha1}:${challenge.nonce}:${ha2}`);
  }
  parts.push(`response="${response}"`);
  if (challenge.algorithm !== "MD5") parts.push(`algorithm=${challenge.algorithm}`);
  if (challenge.opaque) parts.push(`opaque="${quote(challenge.opaque)}"`);
  return `Digest ${parts.join(", ")}`;
}

export const basicAuthorization = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

/** Authorization header answering a challenge (Basic or Digest), or null when it cannot be answered. */
export function answerChallenge(header: string | undefined, credentials: { username: string; password: string }, method: string, uri: string): string | null {
  if (header && /^\s*Basic\b/i.test(header)) return basicAuthorization(credentials.username, credentials.password);
  const challenge = parseDigestChallenge(header);
  return challenge ? digestAuthorization(challenge, { ...credentials, method, uri }) : null;
}
