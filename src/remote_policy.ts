/**
 * What a Studio session from outside the house may do (ARMOR_REMOTE_POLICY), as one pure decision. The route guards (`requireOperator`, `requireAdmin`) ask it for every request that
 * carries a session from outside, so a route added tomorrow with a guard is covered without a second list; the few routes that have no guard of that kind and are still closed from
 * outside are named in REMOTE_BACKSTOP and covered by one small middleware in app.ts. A test walks every registered route and fails when one of them is in neither place.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { gatePath } from "./gate_path.js";
import type { RemotePolicy } from "./remote_admin_gate.js";

/** The things a session from outside may always do: manage its own sign-in, register its phone and ask for the ticket of a camera stream. */
const OWN = /^\/api\/v1\/(studio\/(session|sessions|elevate|totp)|push\/(un)?register)/;
const OWN_TICKET = /^\/api\/v1\/cameras\/[^/]+\/(stream|preview)-ticket$/;
/** What administers the house: users, the installation, the firmware, the broker, the node panels. */
export const REMOTE_ADMIN_PATHS = /^\/api\/v1\/(admin|users|installation|system\/ingest|preferences|solar\/battery-ops|diagnostics\/tokens|nodes\/control|nodes\/[^/]+\/(panel|control|diagnostics))(\/|$)/;
/** The routes that are closed from outside by their path because they carry no `requireOperator` / `requireAdmin`; every other closed route is closed by its guard. The routes that a node or a service calls with its own token (ingest, the observation service) never carry a Studio session, so the policy has nothing to say about them. */
export const REMOTE_BACKSTOP = /^\/api\/v1\/(preferences|account|devices\/trust|operator\/session|control|voice)(\/|$)/;

/** `true` when a session from outside the house may make this request under the policy; the house, the VPN and the policy `full` are never asked. */
export function remoteMayRequest(policy: RemotePolicy, method: string, rawPath: string): boolean {
  if (policy === "full") return true;
  const gated = gatePath(rawPath);
  const reads = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const own = OWN.test(gated) || (method === "POST" && OWN_TICKET.test(gated));
  const admin = REMOTE_ADMIN_PATHS.test(gated);
  if (reads && !(admin && policy === "view")) return true;
  return own || (policy === "operate" && !admin);
}

/** The same decision for the middleware that covers the routes without a guard: only the paths named in REMOTE_BACKSTOP are asked. */
export function remoteBackstopMayRequest(policy: RemotePolicy, method: string, rawPath: string): boolean {
  return !REMOTE_BACKSTOP.test(gatePath(rawPath)) || remoteMayRequest(policy, method, rawPath);
}
