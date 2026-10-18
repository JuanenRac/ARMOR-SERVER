// The second factor under pressure: wrong codes wait longer and longer, an expired or unknown challenge gives nothing, a stolen password is not a new proof from outside
// the house when the second factor is on, and ending the other sessions leaves only the current one.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { TotpStore, fromBase32, stepOf, totpCode } from "../src/totp.js";
import { SECRETS, startServer, tempDir } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const credentials = { username: SECRETS.ARMOR_STUDIO_USERNAME, password: SECRETS.ARMOR_STUDIO_PASSWORD };

function enrolled(clock: { now: number }): { store: TotpStore; secret: Buffer; file: string; recovery: string[] } {
  const file = path.join(tempDir(), "totp.json");
  const store = new TotpStore({ file, secret: "s".repeat(32), now: () => clock.now });
  const begun = store.begin("u1", "someone");
  const secret = fromBase32(begun.secret);
  const recovery = store.confirm("u1", totpCode(secret, stepOf(clock.now)))!;
  return { store, secret, file, recovery };
}

test("five wrong codes in a row make the next tries wait, the wait doubles up to an hour, and even the right code waits", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store, secret } = enrolled(clock);
  clock.now += 60_000;
  for (let index = 0; index < 4; index += 1) assert.equal(store.verify("u1", "000000"), false);
  assert.equal(store.waitFor("u1"), 0, "four wrong codes do not lock yet");
  assert.equal(store.verify("u1", "000000"), false);
  assert.equal(store.waitFor("u1"), 30);
  // the right code is refused while waiting
  assert.equal(store.verify("u1", totpCode(secret, stepOf(clock.now))), false);
  clock.now += 31_000;
  assert.equal(store.waitFor("u1"), 0);
  assert.equal(store.verify("u1", "000000"), false);   // the sixth in a row
  assert.equal(store.waitFor("u1"), 60);
  clock.now += 61_000;
  for (let index = 0; index < 20; index += 1) { store.verify("u1", "000000"); clock.now += 3_700_000; }
  store.verify("u1", "000000");
  assert.ok(store.waitFor("u1") <= 3600, "never more than an hour");
  assert.ok(store.waitFor("u1") >= 3599);
  clock.now += 3_601_000;
  assert.equal(store.verify("u1", totpCode(secret, stepOf(clock.now))), true);
  assert.equal(store.waitFor("u1"), 0, "a good code clears the count");
});

test("a code is accepted one step either side of now, never older, never twice, and only as six digits", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store, secret } = enrolled(clock);
  const step = stepOf(clock.now);
  for (const bad of ["", "12345", "1234567", "abcdef"]) assert.equal(store.verify("u1", bad), false, JSON.stringify(bad));
  assert.equal(store.verify("u1", 123456 as unknown as string), false, "not a string");
  assert.equal(store.verify("u1", totpCode(secret, step + 1)), true, "the next step (a clock a little fast)");
  assert.equal(store.verify("u1", totpCode(secret, step)), false, "an older step than the last accepted is a replay");
  assert.equal(store.verify("nobody", totpCode(secret, step + 5)), false, "a user without the second factor");
});

test("recovery codes are matched without dashes, spaces or case, are used up, and are kept only as hashes", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store, file, recovery } = enrolled(clock);
  assert.equal(store.recoveryLeft("u1"), 10);
  const first = recovery[0]!;
  assert.equal(store.verify("u1", ` ${first.toUpperCase().replace("-", " ")} `), true);
  assert.equal(store.recoveryLeft("u1"), 9);
  assert.equal(store.verify("u1", first), false);
  const saved = fs.readFileSync(file, "utf8");
  for (const code of recovery) assert.equal(saved.includes(code.replace("-", "")), false, "no recovery code is written in clear");
});

test("the secret is sealed with the server key: a store opened with another key accepts nothing, and a damaged file is ignored", () => {
  const clock = { now: 1_800_000_000_000 };
  const { secret, file } = enrolled(clock);
  const other = new TotpStore({ file, secret: "z".repeat(32), now: () => clock.now });
  assert.equal(other.enabled("u1"), true, "the record is there");
  assert.equal(other.verify("u1", totpCode(secret, stepOf(clock.now) + 1)), false, "but it cannot be opened without the key");
  fs.writeFileSync(file, "{ not json");
  const broken = new TotpStore({ file, secret: "s".repeat(32), now: () => clock.now });
  assert.equal(broken.enabled("u1"), false);
  assert.equal(broken.recoveryLeft("u1"), 0);
});

test("a confirmation code that is wrong, or arrives with nothing pending, does not turn the second factor on", () => {
  const clock = { now: 1_800_000_000_000 };
  const store = new TotpStore({ file: path.join(tempDir(), "totp.json"), secret: "s".repeat(32), now: () => clock.now });
  assert.equal(store.confirm("u1", "123456"), undefined, "nothing pending");
  store.begin("u1", "someone");
  assert.equal(store.confirm("u1", "000000"), undefined);
  assert.equal(store.enabled("u1"), false);
  store.disable("u1");
  assert.equal(store.enabled("u1"), false);
});

async function withSecondFactor(extra: Record<string, string> = {}) {
  const running = await startServer(extra);
  const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
  const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
  const call = (method: string, url: string, body?: unknown, jar = cookie) => fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: jar }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setup = await (await call("POST", "/api/v1/studio/totp/setup", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).json() as { secret: string };
  const secret = fromBase32(setup.secret);
  const enabled = await (await call("POST", "/api/v1/studio/totp/enable", { code: totpCode(secret, stepOf(Date.now())) })).json() as { recovery_codes: string[] };
  const first = async () => (await (await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).json()) as { challenge: string };
  const second = (challenge: string, code: string) => fetch(`${running.base}/api/v1/studio/session/totp`, { method: "POST", headers: json, body: JSON.stringify({ challenge, code }) });
  return { running, call, secret, recovery: enabled.recovery_codes, first, second };
}

test("an unknown, empty or used challenge answers challenge_expired; five wrong codes burn the challenge and the sixth waits with Retry-After", async () => {
  const { running, first, second, secret } = await withSecondFactor();
  try {
    for (const bad of ["", "nope", "A".repeat(500)]) {
      const answer = await second(bad, "123456");
      assert.deepEqual([answer.status, ((await answer.json()) as { code: string }).code], [401, "challenge_expired"], JSON.stringify(bad.slice(0, 6)));
    }
    const { challenge } = await first();
    for (let index = 0; index < 5; index += 1) {
      const answer = await second(challenge, "000000");
      assert.deepEqual([answer.status, ((await answer.json()) as { code: string }).code], [401, "bad_code"]);
    }
    const burnt = await second(challenge, totpCode(secret, stepOf(Date.now()) + 1));
    assert.equal(burnt.status, 401, "the challenge is gone after five wrong codes");
    // a new challenge: the person is locked out for a while, even with the right code
    const again = await first();
    const locked = await second(again.challenge, totpCode(secret, stepOf(Date.now()) + 1));
    assert.equal(locked.status, 429);
    assert.equal(((await locked.json()) as { code: string }).code, "totp_locked");
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);
    assert.equal(locked.headers.getSetCookie().length, 0, "no cookie while locked");
  } finally { await running.stop(); }
});

test("a challenge is for one person and one use: a good code opens one session, the same challenge opens no second", async () => {
  const { running, first, second, secret, recovery } = await withSecondFactor();
  try {
    const { challenge } = await first();
    const ok = await second(challenge, totpCode(secret, stepOf(Date.now()) + 1));
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as { user: { username: string } }).user.username, "admin");
    const reused = await second(challenge, recovery[0]!);
    assert.equal(reused.status, 401);
  } finally { await running.stop(); }
});

test("with the second factor on, from outside the house a password alone is not a new proof, a code is; at home the password is enough", async () => {
  const { running, call, secret, recovery } = await withSecondFactor({ ARMOR_LOCAL_NETWORKS: "10.99.0.0/16" });
  try {
    // this server sees every request as remote, so the password is no longer enough to elevate
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    const { challenge } = await login.json() as { challenge: string };
    const done = await fetch(`${running.base}/api/v1/studio/session/totp`, { method: "POST", headers: json, body: JSON.stringify({ challenge, code: totpCode(secret, stepOf(Date.now()) + 1) }) });
    const jar = (done.headers.getSetCookie()[0] ?? "").split(";")[0];
    const byPassword = await call("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD }, jar);
    assert.deepEqual([byPassword.status, ((await byPassword.json()) as { code: string }).code], [401, "bad_proof"]);
    const byBadCode = await call("POST", "/api/v1/studio/elevate", { code: "000000" }, jar);
    assert.equal(byBadCode.status, 401);
    const byCode = await call("POST", "/api/v1/studio/elevate", { code: recovery[0] }, jar);
    assert.equal(byCode.status, 200);
    assert.ok(((await byCode.json()) as { elevated_for_s: number }).elevated_for_s > 0);
    const nothing = await call("POST", "/api/v1/studio/elevate", {}, jar);
    assert.equal(nothing.status, 401, "neither a password nor a code");
  } finally { await running.stop(); }
});

test("elevating asks for a session, and at home the password is a good proof", async () => {
  const running = await startServer();
  try {
    assert.equal((await fetch(`${running.base}/api/v1/studio/elevate`, { method: "POST", headers: json, body: JSON.stringify({ password: SECRETS.ARMOR_STUDIO_PASSWORD }) })).status, 401);
    for (const [method, url] of [["GET", "/api/v1/studio/sessions"], ["POST", "/api/v1/studio/sessions/end-others"], ["DELETE", "/api/v1/studio/sessions/abc"], ["GET", "/api/v1/studio/totp"]] as const) {
      assert.equal((await fetch(`${running.base}${url}`, { method })).status, 401, `${method} ${url}`);
    }
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    const jar = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    const answer = await fetch(`${running.base}/api/v1/studio/elevate`, { method: "POST", headers: { ...json, Cookie: jar }, body: JSON.stringify({ password: SECRETS.ARMOR_STUDIO_PASSWORD }) });
    assert.equal(answer.status, 200);
  } finally { await running.stop(); }
});

test("ending the other sessions leaves the current one signed in and takes the rest down", async () => {
  const running = await startServer();
  try {
    const open = async () => ((await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).headers.getSetCookie()[0] ?? "").split(";")[0];
    const [mine, phone, tablet] = [await open(), await open(), await open()];
    const status = (jar: string) => fetch(`${running.base}/api/v1/studio/session`, { headers: { Cookie: jar } }).then(r => r.json()) as Promise<{ authenticated: boolean }>;
    assert.equal((await status(phone)).authenticated, true);
    assert.equal((await fetch(`${running.base}/api/v1/studio/sessions/end-others`, { method: "POST", headers: { Cookie: mine } })).status, 204);
    assert.equal((await status(mine)).authenticated, true);
    assert.equal((await status(phone)).authenticated, false);
    assert.equal((await status(tablet)).authenticated, false);
  } finally { await running.stop(); }
});

test("setting the second factor up twice, or without the right password, is refused and changes nothing", async () => {
  const { running, call, recovery } = await withSecondFactor();
  try {
    const again = await call("POST", "/api/v1/studio/totp/setup", { password: SECRETS.ARMOR_STUDIO_PASSWORD });
    assert.deepEqual([again.status, ((await again.json()) as { code: string }).code], [409, "already_enabled"]);
    assert.equal(recovery.length, 10);
    const wrong = await call("DELETE", "/api/v1/studio/totp", { password: "not-the-password" });
    assert.deepEqual([wrong.status, ((await wrong.json()) as { code: string }).code], [401, "bad_proof"]);
    const state = await (await call("GET", "/api/v1/studio/totp")).json() as { enabled: boolean; recovery_left: number };
    assert.deepEqual(state, { enabled: true, recovery_left: 10, policy: "off" });
  } finally { await running.stop(); }
});
