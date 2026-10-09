/**
 * The way to the admin agent. This server runs as an unprivileged user, with no sudo and a read-only system, on purpose; what an administrator
 * still needs from Studio - restart a service, edit its settings, add the MQTT account of a new node - is done by a small separate program
 * (ARMOR-DEVOPS/scripts/armor_admin_agent.py) that listens on a Unix socket and can do only a closed list of things. This file is its client:
 * one request at a time over that socket, with the shared token, and nothing else.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import http from "node:http";

export type AdminReply = { status: number; body: Record<string, unknown> };
export type AdminTransport = (method: string, path: string, body?: unknown) => Promise<AdminReply>;

/** The agent as the server uses it: `available` is false when it is not configured or does not answer. */
export type AdminAgent = { request: AdminTransport };

/** Requests over the agent's Unix socket. A restart or an account change can take a few seconds, so the limit is generous. */
export function unixTransport(socketPath: string, token: string, timeoutMs = 70_000): AdminTransport {
  return (method, path, body) => new Promise<AdminReply>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      socketPath, method, path, timeout: timeoutMs,
      headers: { "X-Armor-Admin-Token": token, "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => {
        try { resolve({ status: response.statusCode ?? 502, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }); }
        catch { resolve({ status: 502, body: { error: "bad_answer" } }); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export const MASK = "********";
const SECRET_KEY = /(PASSWORD|SECRET|TOKEN|KEY|PASS|WEBHOOK_ID)/i;

/** The text of an environment file with the value of every secret replaced by a mask: an administrator sees which exist, never what they are. */
export function maskEnv(content: string): string {
  return content.split("\n").map(line => {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    return match && SECRET_KEY.test(match[2]) && match[3] !== "" ? `${match[1]}${match[2]}=${MASK}` : line;
  }).join("\n");
}

/** What was edited, with every masked line given back the value it had; a mask for a key that is not in the file any more is refused. */
export function unmaskEnv(edited: string, current: string): { content: string } | { missing: string } {
  const known = new Map<string, string>();
  for (const line of current.split("\n")) { const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line); if (match) known.set(match[1], match[2]); }
  let missing = "";
  const content = edited.split("\n").map(line => {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || match[3] !== MASK) return line;
    const value = known.get(match[2]);
    if (value === undefined) { missing = match[2]; return line; }
    return `${match[1]}${match[2]}=${value}`;
  }).join("\n");
  return missing ? { missing } : { content };
}
