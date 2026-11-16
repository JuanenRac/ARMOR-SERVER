/**
 * What a session from outside the house may do on a route that asks for an administrator, read from the route itself and not from a second list of paths: every route registered with
 * `requireAdmin` is administering, so one added tomorrow is closed from outside by default. With the policy `operate` the administrator may still look (except at the secrets) and
 * may do the few things that operate the house (arm and disarm, switch a circuit, change the arming mode); with `view` nothing of it is open. The policy `full` and the house itself
 * are not touched. The option `remote.gate_by_route` turns this gate off (on, the default).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */

/** The routes with `requireAdmin` that operate the house and stay open to an administrator from outside under the policy `operate`: `METHOD /pattern` as the route is written. */
export const REMOTE_OPERATE_ADMIN_ROUTES: readonly string[] = [
  "POST /api/v1/alarm/command",
  "POST /api/v1/electrical/switch",
  "PUT /api/v1/alarm/modes",
];

/** Reads that return a secret: closed from outside under `operate` too, although they only read. */
export const REMOTE_SECRET_READS: readonly string[] = [
  "GET /api/v1/alarm/zone-feed/key/:node",
];

export type RemotePolicy = "full" | "operate" | "view";

/** Whether a session from outside the house may use an administrator route; `pattern` is the route as it was registered (`/api/v1/alarm/command`). */
export function remoteMayUseAdminRoute(policy: RemotePolicy, method: string, pattern: string): boolean {
  if (policy === "full") return true;
  if (policy === "view") return false;
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const key = `${verb} ${pattern}`;
  if (REMOTE_OPERATE_ADMIN_ROUTES.includes(key)) return true;
  return verb === "GET" || verb === "OPTIONS" ? !REMOTE_SECRET_READS.includes(key) : false;
}
