import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";
import { UserError, UserStore } from "../src/users.js";

const json = { "Content-Type": "application/json" };
const api = async (base: string, cookie: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
};
const login = async (base: string, username: string, password: string) => {
  const response = await fetch(`${base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username, password }) });
  return { status: response.status, cookie: (response.headers.getSetCookie()[0] ?? "").split(";")[0] };
};

const store = (extra: Partial<ConstructorParameters<typeof UserStore>[0]> = {}) =>
  new UserStore({ file: path.join(tempDir(), "users.json"), seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8, ...extra });

test("the first start creates the configured administrator, and keeps only a hash of the password", () => {
  const users = store();
  assert.equal(users.list().length, 1);
  assert.equal(users.list()[0].role, "admin");
  assert.ok(users.authenticate("admin", "correct-horse-battery"));
  assert.ok(users.authenticate("ADMIN", "correct-horse-battery"), "user names ignore case");
  assert.equal(users.authenticate("admin", "wrong"), null);
  assert.equal(users.authenticate("nobody", "correct-horse-battery"), null);
});

test("users survive a restart, and the configured password no longer overrides what was changed", () => {
  const file = path.join(tempDir(), "users.json");
  const first = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8 });
  const admin = first.list()[0];
  first.update(admin.id, { password: "a-new-password-1", username: "boss" });
  first.create({ username: "guard", password: "guard-password-1", role: "operator" });
  const again = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8 });
  assert.deepEqual(again.list().map(user => user.username).sort(), ["boss", "guard"]);
  assert.equal(again.authenticate("boss", "correct-horse-battery"), null);
  assert.ok(again.authenticate("boss", "a-new-password-1"));
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /correct-horse|a-new-password|guard-password/, "no password is ever stored");
});

test("a forgotten password can be reset from the configuration on purpose", () => {
  const file = path.join(tempDir(), "users.json");
  const first = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8 });
  first.update(first.list()[0].id, { password: "something-else-1" });
  const reset = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8, resetSeedPassword: true });
  assert.ok(reset.authenticate("admin", "correct-horse-battery"));
});

test("names, passwords and roles are validated, and a name is unique whatever its case", () => {
  const users = store();
  const code = (action: () => unknown) => { try { action(); } catch (error) { return (error as UserError).code; } return "ok"; };
  assert.equal(code(() => users.create({ username: "ab", password: "long-enough-1", role: "operator" })), "invalid_username");
  assert.equal(code(() => users.create({ username: "has space", password: "long-enough-1", role: "operator" })), "invalid_username");
  assert.equal(code(() => users.create({ username: "guard", password: "short", role: "operator" })), "weak_password");
  assert.equal(code(() => users.create({ username: "guard", password: "long-enough-1", role: "root" })), "invalid_role");
  assert.equal(code(() => users.create({ username: "Admin", password: "long-enough-1", role: "operator" })), "username_taken");
  assert.equal(code(() => users.create({ username: "guard", password: "long-enough-1", role: "operator" })), "ok");
  assert.equal(code(() => users.update(users.list()[1].id, { username: "ADMIN" })), "username_taken");
  assert.equal(users.list()[1].username, "guard", "a refused change leaves the user as it was");
});

test("there is always one administrator", () => {
  const users = store(), admin = users.list()[0];
  assert.throws(() => users.remove(admin.id), /administrator/);
  assert.throws(() => users.update(admin.id, { role: "operator" }), /administrator/);
  const second = users.create({ username: "second", password: "long-enough-1", role: "admin" });
  users.update(admin.id, { role: "operator" });
  assert.throws(() => users.remove(second.id), /administrator/);
});

test("with no administrator in the file, the configured one is put back so Studio cannot be locked out", () => {
  const file = path.join(tempDir(), "users.json");
  const first = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8 });
  first.create({ username: "guard", password: "long-enough-1", role: "operator" });
  const damaged = JSON.parse(fs.readFileSync(file, "utf8")) as { users: Array<{ role: string }> };
  damaged.users.forEach(user => { user.role = "operator"; });
  fs.writeFileSync(file, JSON.stringify(damaged));
  const again = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8 });
  assert.equal(again.list().filter(user => user.role === "admin").length, 1);
});

test("an administrator manages users over HTTP; an operator cannot", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const created = await api(running.base, admin, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" });
    assert.equal(created.status, 201);
    assert.equal(created.body.role, "operator");
    assert.equal(JSON.stringify(created.body).includes("guard-password"), false);
    const listed = await api(running.base, admin, "GET", "/api/v1/users");
    assert.equal((listed.body.users as unknown[]).length, 2);
    assert.equal((listed.body.users as Array<{ username: string; current: boolean }>).find(user => user.username === "admin")?.current, true);

    const operator = await login(running.base, "guard", "guard-password-1");
    assert.equal(operator.status, 201);
    const forbidden = await api(running.base, operator.cookie, "GET", "/api/v1/users");
    assert.equal(forbidden.status, 403);
    assert.equal((await api(running.base, operator.cookie, "POST", "/api/v1/users", { username: "third", password: "long-enough-1" })).status, 403);
    assert.equal((await api(running.base, "", "GET", "/api/v1/users")).status, 401);
    // the operator token is a service credential: it does not manage users
    const byToken = await fetch(`${running.base}/api/v1/users`, { headers: { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } });
    assert.equal(byToken.status, 401);
    // but an operator still operates
    assert.equal((await api(running.base, operator.cookie, "GET", "/api/v1/cameras")).status, 200);
    const who = await api(running.base, operator.cookie, "GET", "/api/v1/studio/session");
    assert.deepEqual(who.body.user && { username: (who.body.user as Record<string, unknown>).username, role: (who.body.user as Record<string, unknown>).role }, { username: "guard", role: "operator" });
  } finally { await running.stop(); }
});

test("renaming a user or changing a password takes effect at once and ends that user's other sessions", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const created = await api(running.base, admin, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" });
    const id = String(created.body.id);
    const session = await login(running.base, "guard", "guard-password-1");
    assert.equal((await api(running.base, session.cookie, "GET", "/api/v1/cameras")).status, 200);

    const changed = await api(running.base, admin, "PATCH", `/api/v1/users/${id}`, { username: "night-guard", password: "another-password-2" });
    assert.equal(changed.status, 200);
    assert.equal((await api(running.base, session.cookie, "GET", "/api/v1/cameras")).status, 401, "the old session ended");
    assert.equal((await login(running.base, "guard", "guard-password-1")).status, 401);
    assert.equal((await login(running.base, "night-guard", "guard-password-1")).status, 401);
    assert.equal((await login(running.base, "night-guard", "another-password-2")).status, 201);
    assert.equal((await api(running.base, admin, "PATCH", `/api/v1/users/${id}`, { role: "boss" })).status, 400);
    assert.equal((await api(running.base, admin, "PATCH", "/api/v1/users/u-nope", { role: "admin" })).status, 404);

    const removed = await api(running.base, admin, "DELETE", `/api/v1/users/${id}`);
    assert.equal(removed.status, 204);
    assert.equal((await login(running.base, "night-guard", "another-password-2")).status, 401);
    const me = (await api(running.base, admin, "GET", "/api/v1/users")).body.users as Array<{ id: string }>;
    assert.equal((await api(running.base, admin, "DELETE", `/api/v1/users/${me[0].id}`)).status, 409, "you cannot delete yourself");
  } finally { await running.stop(); }
});

test("anyone signed in can change their own name and password, but only with the current password", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    await api(running.base, admin, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" });
    const guard = await login(running.base, "guard", "guard-password-1");
    const other = await login(running.base, "guard", "guard-password-1");

    assert.equal((await api(running.base, guard.cookie, "PATCH", "/api/v1/account", { newPassword: "brand-new-pass-3" })).status, 403, "no current password");
    assert.equal((await api(running.base, guard.cookie, "PATCH", "/api/v1/account", { currentPassword: "nope", newPassword: "brand-new-pass-3" })).status, 403);
    assert.equal((await api(running.base, guard.cookie, "PATCH", "/api/v1/account", { currentPassword: "guard-password-1", newPassword: "short" })).status, 400);
    assert.equal((await api(running.base, guard.cookie, "PATCH", "/api/v1/account", { currentPassword: "guard-password-1" })).status, 400, "nothing to change");
    const done = await api(running.base, guard.cookie, "PATCH", "/api/v1/account", { currentPassword: "guard-password-1", newPassword: "brand-new-pass-3", username: "keeper" });
    assert.equal(done.status, 200);
    assert.equal(done.body.username, "keeper");
    assert.equal((await api(running.base, guard.cookie, "GET", "/api/v1/cameras")).status, 200, "this session stays");
    assert.equal((await api(running.base, other.cookie, "GET", "/api/v1/cameras")).status, 401, "another session of the same user ends");
    assert.equal((await login(running.base, "keeper", "brand-new-pass-3")).status, 201);
    assert.equal((await api(running.base, "", "PATCH", "/api/v1/account", { currentPassword: "x", newPassword: "long-enough-1" })).status, 401);
  } finally { await running.stop(); }
});

test("the administrator seeded from the environment can sign in, and a wrong user or password is refused alike", async () => {
  const running = await startServer();
  try {
    assert.equal((await login(running.base, SECRETS.ARMOR_STUDIO_USERNAME, SECRETS.ARMOR_STUDIO_PASSWORD)).status, 201);
    assert.equal((await login(running.base, SECRETS.ARMOR_STUDIO_USERNAME, "wrong")).status, 401);
    assert.equal((await login(running.base, "nobody", SECRETS.ARMOR_STUDIO_PASSWORD)).status, 401);
    const file = path.join(running.config.dataDir, "users.json");
    assert.equal(fs.existsSync(file), true);
    if (process.platform !== "win32") assert.equal((fs.statSync(file).mode & 0o077), 0, "the users file is private");
  } finally { await running.stop(); }
});
