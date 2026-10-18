// The edges of account management over HTTP: what an administrator cannot do to themselves, what a person does to their own account, and what never leaves the server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };

async function setup() {
  const running = await startServer();
  const admin = await studioCookie(running.base);
  const call = (jar: string, method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { ...json, cookie: jar }, body: body === undefined ? undefined : JSON.stringify(body) });
  const make = async (username: string, role: string) => {
    const made = await call(admin, "POST", "/api/v1/users", { username, password: `${username}-password-1`, role });
    assert.equal(made.status, 201);
    const id = ((await made.json()) as { id: string }).id;
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username, password: `${username}-password-1` }) });
    return { id, jar: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
  };
  const me = (await (await fetch(`${running.base}/api/v1/studio/session`, { headers: { cookie: admin } })).json() as { user: { id: string } }).user.id;
  const audit = () => fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
  return { running, admin, call, make, me, audit };
}

test("an administrator cannot delete the account they are signed in with, nor one that does not exist, and the failure is in the trail", async () => {
  const { running, admin, call, me, audit } = await setup();
  try {
    const self = await call(admin, "DELETE", `/api/v1/users/${me}`);
    assert.deepEqual([self.status, ((await self.json()) as { code: string }).code], [409, "self_delete"]);
    const missing = await call(admin, "DELETE", "/api/v1/users/nobody-here");
    assert.equal(missing.status >= 400 && missing.status < 500, true, `a missing user is a client error, got ${missing.status}`);
    assert.match(audit(), /"action":"user\.delete","outcome":"failed"/);
    assert.equal(((await (await call(admin, "GET", "/api/v1/users")).json()) as { users: unknown[] }).users.length, 1);
  } finally { await running.stop(); }
});

test("deleting a user ends their sessions at once and removes the account; demoting an administrator ends theirs too", async () => {
  const { running, admin, call, make } = await setup();
  try {
    const guard = await make("guard", "operator");
    const second = await make("second", "admin");
    const alive = async (jar: string) => ((await (await fetch(`${running.base}/api/v1/studio/session`, { headers: { cookie: jar } })).json()) as { authenticated: boolean }).authenticated;
    assert.equal(await alive(guard.jar), true);
    assert.equal((await call(admin, "DELETE", `/api/v1/users/${guard.id}`)).status, 204);
    assert.equal(await alive(guard.jar), false, "the session of a deleted user is gone");
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guard", password: "guard-password-1" }) })).status, 401);
    assert.equal(await alive(second.jar), true);
    assert.equal((await call(admin, "PATCH", `/api/v1/users/${second.id}`, { role: "viewer" })).status, 200);
    assert.equal(await alive(second.jar), false, "a change of role signs the person out");
  } finally { await running.stop(); }
});

test("a PIN is never shown again: not when set, not in the list, not in the trail", async () => {
  const { running, admin, call, make, audit } = await setup();
  try {
    const guard = await make("guard", "operator");
    const set = await (await call(admin, "PUT", `/api/v1/users/${guard.id}/pin`, { pin: "2468", duress_pin: "1357" })).json() as Record<string, unknown>;
    assert.equal(set.hasPin, true);
    assert.equal(set.hasDuress, true);
    const listed = JSON.stringify(await (await call(admin, "GET", "/api/v1/users")).json());
    for (const secret of ["2468", "1357", "guard-password-1", "hash", "salt"]) assert.equal(JSON.stringify(set).includes(secret) || listed.includes(secret), false, `${secret} must not be sent`);
    assert.equal(/2468|1357/.test(audit()), false);
    const file = fs.readFileSync(path.join(running.config.dataDir, "users.json"), "utf8");
    assert.equal(/2468|1357|guard-password-1/.test(file), false, "only hashes are kept");
    const cleared = await (await call(admin, "DELETE", `/api/v1/users/${guard.id}/pin`)).json() as Record<string, unknown>;
    assert.deepEqual([cleared.hasPin, cleared.hasDuress], [false, false]);
    assert.equal((await call(admin, "PUT", `/api/v1/users/${guard.id}/pin`, { pin: "1234", duress_pin: "1234" })).status, 400, "the duress PIN cannot be the same as the PIN");
    assert.equal((await call(admin, "PUT", "/api/v1/users/ghost/pin", { pin: "2468" })).status >= 400, true);
  } finally { await running.stop(); }
});

test("your own PIN: it needs a session and the current password, and a wrong password changes nothing and is in the trail", async () => {
  const { running, call, make, audit } = await setup();
  try {
    const guard = await make("guard", "operator");
    assert.equal((await fetch(`${running.base}/api/v1/account/pin`, { method: "PUT", headers: json, body: JSON.stringify({ currentPassword: "x", pin: "2468" }) })).status, 401);
    const wrong = await call(guard.jar, "PUT", "/api/v1/account/pin", { currentPassword: "not-it", pin: "2468" });
    assert.deepEqual([wrong.status, ((await wrong.json()) as { code: string }).code], [403, "wrong_password"]);
    const missing = await call(guard.jar, "PUT", "/api/v1/account/pin", { pin: "2468" });
    assert.equal(missing.status, 403, "no password at all is the same as a wrong one");
    const bad = await call(guard.jar, "PUT", "/api/v1/account/pin", { currentPassword: "guard-password-1", pin: "12" });
    assert.equal(bad.status, 400);
    const ok = await (await call(guard.jar, "PUT", "/api/v1/account/pin", { currentPassword: "guard-password-1", pin: "2468" })).json() as { hasPin: boolean };
    assert.equal(ok.hasPin, true);
    const cleared = await (await call(guard.jar, "PUT", "/api/v1/account/pin", { currentPassword: "guard-password-1", clear: true })).json() as { hasPin: boolean };
    assert.equal(cleared.hasPin, false);
    assert.match(audit(), /"action":"account\.pin","outcome":"denied"/);
  } finally { await running.stop(); }
});

test("your own account: nothing to change is a 400, a wrong current password a 403, a new password signs the other sessions out and keeps this one", async () => {
  const { running, call, make } = await setup();
  try {
    const guard = await make("guard", "operator");
    const other = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guard", password: "guard-password-1" }) });
    const otherJar = (other.headers.getSetCookie()[0] ?? "").split(";")[0];
    assert.equal((await fetch(`${running.base}/api/v1/account`, { method: "PATCH", headers: json, body: JSON.stringify({ currentPassword: "guard-password-1", newPassword: "whatever-long-1" }) })).status, 401);
    const nothing = await call(guard.jar, "PATCH", "/api/v1/account", { currentPassword: "guard-password-1" });
    assert.deepEqual([nothing.status, ((await nothing.json()) as { code: string }).code], [400, "nothing_to_change"]);
    assert.equal((await call(guard.jar, "PATCH", "/api/v1/account", { currentPassword: "wrong", newPassword: "whatever-long-1" })).status, 403);
    assert.equal((await call(guard.jar, "PATCH", "/api/v1/account", { currentPassword: "guard-password-1", newPassword: "short" })).status, 400);
    const changed = await call(guard.jar, "PATCH", "/api/v1/account", { currentPassword: "guard-password-1", newPassword: "whatever-long-1" });
    assert.equal(changed.status, 200);
    const body = await changed.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["id", "role", "username"], "only who they are, nothing else");
    const alive = async (jar: string) => ((await (await fetch(`${running.base}/api/v1/studio/session`, { headers: { cookie: jar } })).json()) as { authenticated: boolean }).authenticated;
    assert.equal(await alive(guard.jar), true);
    assert.equal(await alive(otherJar), false);
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guard", password: "guard-password-1" }) })).status, 401, "the old password no longer works");
  } finally { await running.stop(); }
});

test("the account routes are rate limited per place: a loop of wrong passwords is stopped", async () => {
  const { running, call, make } = await setup();
  try {
    const guard = await make("guard", "operator");
    const seen = new Set<number>();
    for (let index = 0; index < 24; index += 1) seen.add((await call(guard.jar, "PATCH", "/api/v1/account", { currentPassword: "wrong", newPassword: "whatever-long-1" })).status);
    assert.equal(seen.has(403), true);
    assert.equal(seen.has(429), true, "after twenty tries it says too many");
  } finally { await running.stop(); }
});
