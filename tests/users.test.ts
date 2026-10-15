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

test("a signed-in console is never rate limited by its own polling, while an anonymous flood still is", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    let refused = 0;
    for (let index = 0; index < 300; index += 1) if ((await fetch(`${running.base}/api/v1/status`, { headers: { cookie } })).status === 429) refused += 1;
    assert.equal(refused, 0, "300 requests in a minute from a signed-in operator all get through");
    let limited = 0;
    for (let index = 0; index < 300; index += 1) if ((await fetch(`${running.base}/api/v1/status`)).status === 429) limited += 1;
    assert.ok(limited > 0, "an anonymous client is still limited");
  } finally { await running.stop(); }
});

test("a signed-in session survives a server restart, and the file holds no usable cookie", async () => {
  const dataDir = tempDir();
  const first = await startServer({ ARMOR_DATA_DIR: dataDir });
  const cookie = await studioCookie(first.base);
  const value = decodeURIComponent(cookie.split("=")[1]);
  await first.stop();
  assert.equal(fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8").includes(value), false, "only a hash of the session id is written");
  const second = await startServer({ ARMOR_DATA_DIR: dataDir });
  try {
    assert.equal((await api(second.base, cookie, "GET", "/api/v1/users")).status, 200, "the same cookie still works after the restart");
    await api(second.base, cookie, "DELETE", "/api/v1/studio/session");
    assert.equal((await api(second.base, cookie, "GET", "/api/v1/users")).status, 401);
  } finally { await second.stop(); }
  const third = await startServer({ ARMOR_DATA_DIR: dataDir });
  try { assert.equal((await api(third.base, cookie, "GET", "/api/v1/users")).status, 401, "a signed-out session stays signed out"); } finally { await third.stop(); }
});

test("a PIN to disarm: kept as a hash, wrong ones lock the user for longer each time, the duress one is told apart", () => {
  const file = path.join(tempDir(), "users.json");
  const users = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8 });
  const id = users.list()[0].id;
  assert.equal(users.verifyPin(id, "1234"), "none");
  assert.equal(users.list()[0].hasPin, false);
  for (const bad of ["123", "12345678901", "abcd", 1234, "", undefined]) assert.throws(() => users.setPin(id, bad), (e: unknown) => e instanceof UserError && e.code === "invalid_pin");
  assert.throws(() => users.setPin(id, "4321", "4321"), (e: unknown) => e instanceof UserError && e.code === "same_pin");
  const user = users.setPin(id, "4321", "1111");
  assert.equal(user.hasPin, true);
  assert.equal(user.hasDuress, true);
  assert.ok(!fs.readFileSync(file, "utf8").includes("4321"), "only a hash is kept");
  assert.ok(!JSON.stringify(users.list()).includes("hash"));
  let now = 1_000_000;
  assert.equal(users.verifyPin(id, "4321", now), "ok");
  assert.equal(users.verifyPin(id, "1111", now), "duress");
  assert.equal(users.verifyPin(id, "0000", now), "bad");
  assert.equal(users.verifyPin(id, "0000", now), "bad");
  assert.equal(users.verifyPin(id, "0000", now), "locked");        // the third one in a row: a minute
  assert.equal(users.verifyPin(id, "4321", now + 59_000), "locked", "even the right PIN waits");
  assert.equal(users.pinLockedFor(id, now + 59_000), 1);
  now += 61_000;
  assert.equal(users.verifyPin(id, "0000", now), "bad");
  assert.equal(users.verifyPin(id, "0000", now), "bad");
  assert.equal(users.verifyPin(id, "0000", now), "locked");        // the second lock: five minutes
  assert.equal(users.verifyPin(id, "4321", now + 200_000), "locked");
  assert.equal(users.verifyPin(id, "4321", now + 301_000), "ok");
  assert.equal(users.verifyPin(id, "0000", now + 301_000), "bad");  // a right one cleared the count
  // it survives a restart, without the lock
  const again = new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8 });
  assert.equal(again.verifyPin(id, "4321"), "ok");
  assert.equal(again.list()[0].hasDuress, true);
  again.setPin(id, "5555");
  assert.equal(again.list()[0].hasDuress, false, "setting only a PIN removes the duress one");
  assert.equal(again.verifyPin(id, "1111"), "bad");
  again.clearPin(id);
  assert.equal(again.verifyPin(id, "5555"), "none");
  assert.throws(() => again.setPin("u-nobody", "1234"), (e: unknown) => e instanceof UserError && e.code === "not_found");
});

test("disarming over HTTP asks for the PIN: wrong, locked, duress with a silent critical alarm, and the required policy", async () => {
  const running = await startServer({ ARMOR_DISARM_PIN: "required" });
  try {
    const cookie = await studioCookie(running.base);
    const me = (await api(running.base, cookie, "GET", "/api/v1/users")).body.users as Array<{ id: string; current: boolean }>;
    const id = me.find(user => user.current)!.id;
    const disarm = (pin?: string) => api(running.base, cookie, "POST", "/api/v1/mode", { mode: "disarmed", ...(pin === undefined ? {} : { pin }) });
    assert.equal((await api(running.base, cookie, "POST", "/api/v1/mode", { mode: "armed" })).status, 200, "arming never asks for a PIN");
    const none = await disarm("1234");
    assert.equal(none.status, 403);
    assert.equal(none.body.code, "pin_not_set");
    assert.equal((await api(running.base, cookie, "PUT", `/api/v1/users/${id}/pin`, { pin: "12", duress_pin: "" })).status, 400);
    assert.equal((await api(running.base, cookie, "PUT", `/api/v1/users/${id}/pin`, { pin: "2468", duress_pin: "1357" })).status, 200);
    assert.equal((await disarm()).body.code, "wrong_pin");
    assert.equal((await disarm("0000")).body.code, "wrong_pin");
    const locked = await disarm("0000");
    assert.equal(locked.status, 429);
    assert.equal(locked.body.code, "pin_locked");
    assert.equal((await disarm("2468")).status, 429, "the right PIN waits as well");
    // another user has his own PIN and his own lock: the right PIN and the duress PIN
    const guard = (await api(running.base, cookie, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" })).body.id as string;
    assert.equal((await api(running.base, cookie, "PUT", `/api/v1/users/${guard}/pin`, { pin: "8642", duress_pin: "9753" })).status, 200);
    const guardCookie = (await login(running.base, "guard", "guard-password-1")).cookie;
    const post = (pin: string) => api(running.base, guardCookie, "POST", "/api/v1/mode", { mode: "disarmed", pin });
    assert.equal((await post("8642")).status, 200);
    assert.equal(((await api(running.base, guardCookie, "GET", "/api/v1/alarms")).body.active as unknown[]).length, 0, "the right PIN raises nothing");
    await api(running.base, guardCookie, "POST", "/api/v1/mode", { mode: "armed" });
    assert.equal((await post("9753")).status, 200, "the duress PIN disarms as well");
    const active = (await api(running.base, guardCookie, "GET", "/api/v1/alarms")).body.active as Array<{ code: string; severity: string }>;
    assert.deepEqual(active.map(alarm => [alarm.code, alarm.severity]), [["duress_disarm", "critical"]]);
  } finally { await running.stop(); }
});

test("without ARMOR_DISARM_PIN=required a user without a PIN still disarms, and a user with one needs it", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await api(running.base, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).status, 200);
    const id = ((await api(running.base, cookie, "GET", "/api/v1/users")).body.users as Array<{ id: string; current: boolean }>).find(user => user.current)!.id;
    await api(running.base, cookie, "PUT", `/api/v1/users/${id}/pin`, { pin: "2468" });
    assert.equal((await api(running.base, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).body.code, "wrong_pin");
    assert.equal((await api(running.base, cookie, "POST", "/api/v1/mode", { mode: "disarmed", pin: "2468" })).status, 200);
    assert.equal((await api(running.base, cookie, "DELETE", `/api/v1/users/${id}/pin`)).status, 200);
    assert.equal((await api(running.base, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).status, 200);
  } finally { await running.stop(); }
});

test("a users file damaged by a power cut is never overwritten by the seed: the last good copy is used", () => {
  const file = path.join(tempDir(), "users.json");
  const warnings: string[] = [];
  const make = () => new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8, warn: message => warnings.push(message) });
  const first = make();
  first.create({ username: "guard", password: "guard-password-1", role: "operator" });
  first.create({ username: "second", password: "second-password-1", role: "operator" });   // a save makes the copy of the one before
  fs.writeFileSync(file, "");                                                             // what a power cut leaves
  const again = make();
  assert.deepEqual(again.list().map(user => user.username).sort(), ["admin", "guard"], "the accounts of the last good copy are back");
  assert.ok(warnings.some(message => message.includes("last good copy")));
  // no copy at all: the damaged file is kept aside, not destroyed
  const lone = path.join(tempDir(), "users.json");
  fs.writeFileSync(lone, "{broken");
  const fresh = new UserStore({ file: lone, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8, warn: message => warnings.push(message) });
  assert.equal(fresh.list().length, 1);
  assert.equal(fs.readFileSync(`${lone}.damaged`, "utf8"), "{broken");
});
