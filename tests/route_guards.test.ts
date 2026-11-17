import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "./helpers.js";
import { remoteBackstopMayRequest, remoteMayRequest } from "../src/remote_policy.js";
import { gatePath } from "../src/gate_path.js";
import type { RemotePolicy } from "../src/remote_admin_gate.js";

// Every route the server registers, with the guards in its chain, read from the router itself (app.router.stack), so a route added tomorrow is seen without a second list.
type Walked = { key: string; method: string; path: string; guards: string[] };
function walk(stack: any[], found: Walked[] = []): Walked[] {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) found.push({ key: `${method.toUpperCase()} ${layer.route.path}`, method: method.toUpperCase(), path: String(layer.route.path), guards: layer.route.stack.map((item: any) => item.handle.name || "") });
    } else if (layer.handle?.stack) walk(layer.handle.stack, found);
  }
  return found;
}
const sample = (pattern: string): string => pattern.replace(/:[A-Za-z_]+/g, "x");

/** Routes that carry neither requireOperator nor requireAdmin: they check who asks by other means (a node token, the AI token, the sign-in itself, a signed-in session) or are public on purpose. */
const UNGUARDED: readonly string[] = [
  "GET /healthz",
  "GET /api/v1/info",
  "POST /api/v1/telemetry",
  "POST /api/v1/health",
  "POST /api/v1/control/:mode",
  "GET /api/v1/studio/session",
  "POST /api/v1/studio/session",
  "POST /api/v1/studio/session/totp",
  "GET /api/v1/studio/sessions",
  "DELETE /api/v1/studio/sessions/:id",
  "POST /api/v1/studio/sessions/end-others",
  "POST /api/v1/studio/elevate",
  "GET /api/v1/studio/totp",
  "POST /api/v1/studio/totp/setup",
  "POST /api/v1/studio/totp/enable",
  "DELETE /api/v1/studio/totp",
  "DELETE /api/v1/studio/session",
  "POST /api/v1/operator/session",
  "GET /api/v1/devices/trust",
  "POST /api/v1/devices/trust",
  "DELETE /api/v1/devices/trust/:id",
  "POST /api/v1/devices/trust/challenge",
  "POST /api/v1/devices/trust/session",
  "PUT /api/v1/account/pin",
  "PUT /api/v1/account/panic-phrase",
  "PATCH /api/v1/account",
  "GET /api/v1/preferences",
  "PUT /api/v1/preferences",
  "POST /api/v1/devices/state",
  "POST /api/v1/solar",
  "POST /api/v1/electrical/readings",
  "POST /api/v1/alarm/state",
  "POST /api/v1/network/state",
  "POST /api/v1/node-health",
  "GET /api/v1/diagnostics/nodes",
  "GET /api/v1/diagnostics/nodes/:id",
  "GET /api/v1/diagnostics/nodes/:id/package",
  "GET /api/v1/diagnostics/nodes/:id/log",
  "GET /api/v1/maintenance/armed",
  "GET /api/v1/enrolment/:code",
  "GET /metrics",
  "POST /api/v1/voice/wake",
  "POST /api/v1/voice/turn",
  "POST /api/v1/voice/v1/turn",
  "GET /api/v1/ai/context",
  "GET /api/v1/ai/cameras/:id/frame",
  "POST /api/v1/ai/observations",
  "POST /api/v1/ai/vision-events",
  "POST /api/v1/ai/activity-events",
  "POST /api/v1/ai/ignore-proposals",
  "GET /api/v1/cameras/:id/mjpeg",
  "GET /api/v1/cameras/:id/preview",
];

test("every route of the server is guarded by requireOperator / requireAdmin or is named in the list of routes that check who asks by other means", async () => {
  const running = await startServer();
  try {
    const routes = walk((running.app.express as any).router.stack);
    assert.ok(routes.length > 250, `the walk found only ${routes.length} routes`);
    const unguarded = routes.filter(route => !route.guards.includes("requireOperator") && !route.guards.includes("requireAdmin")).map(route => route.key);
    assert.deepEqual([...unguarded].sort(), [...UNGUARDED].sort(), "a route without requireOperator / requireAdmin must be added to the list on purpose (and a removed one taken out)");
  } finally { await running.stop(); }
});

const TOKEN_ROUTES = ["POST /api/v1/ai/activity-events", "POST /api/v1/ai/ignore-proposals", "POST /api/v1/ai/observations", "POST /api/v1/ai/vision-events", "POST /api/v1/alarm/state", "POST /api/v1/devices/state", "POST /api/v1/electrical/readings", "POST /api/v1/health", "POST /api/v1/network/state", "POST /api/v1/node-health", "POST /api/v1/solar", "POST /api/v1/telemetry"];

// The decision as it was written before it moved into the guards: one regular expression over the path for every route.
function previousVerdict(policy: RemotePolicy, method: string, rawPath: string): boolean {
  if (policy === "full") return true;
  const reads = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const gated = gatePath(rawPath);
  const own = /^\/api\/v1\/(studio\/(session|sessions|elevate|totp)|push\/(un)?register)/.test(gated) || (method === "POST" && /^\/api\/v1\/cameras\/[^/]+\/(stream|preview)-ticket$/.test(gated));
  const admin = /^\/api\/v1\/(admin|users|installation|system\/ingest|preferences|solar\/battery-ops|diagnostics\/tokens|nodes\/control|nodes\/[^/]+\/(panel|control|diagnostics))(\/|$)/.test(gated);
  if (reads && !(admin && policy === "view")) return true;
  return own || (policy === "operate" && !admin);
}

test("no route is left open from outside by moving the remote policy into the guards: each route is closed by its guard or by the backstop exactly as before", async () => {
  const running = await startServer();
  try {
    const routes = walk((running.app.express as any).router.stack);
    const differ: string[] = [];
    for (const policy of ["operate", "view"] as const) {
      for (const route of routes) {
        const path = sample(route.path);
        const guarded = route.guards.includes("requireOperator") || route.guards.includes("requireAdmin");
        const now = guarded ? remoteMayRequest(policy, route.method, path) : remoteBackstopMayRequest(policy, route.method, path);
        if (now !== previousVerdict(policy, route.method, path)) differ.push(`${policy} ${route.key}`);
      }
    }
    // The only difference is on routes that a node or a service calls with its own token and never with a Studio session: the policy has nothing to say about them.
    assert.deepEqual([...new Set(differ.map(item => item.replace(/^\w+ /, "")))].sort(), TOKEN_ROUTES.map(item => item).sort());
  } finally { await running.stop(); }
});

test("the public sign-in limit lives in the sign-in routes, not in a middleware of the whole server", async () => {
  const running = await startServer();
  try {
    const login = walk((running.app.express as any).router.stack).filter(route => route.key === "POST /api/v1/studio/session" || route.key === "POST /api/v1/studio/session/totp");
    assert.equal(login.length, 2);
    for (const route of login) assert.ok(route.guards.some(name => name === "publicLoginGuard"), route.key);
  } finally { await running.stop(); }
});
