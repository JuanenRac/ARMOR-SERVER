// Using the server from outside the house: where a request comes from, the second factor, the sessions of a person and the new proof the critical actions ask for.
import assert from "node:assert/strict";
import test from "node:test";
import { classify, inRanges, parseRanges } from "../src/origin.js";
import { base32, fromBase32, stepOf, totpCode } from "../src/totp.js";
import { SECRETS, startServer } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const credentials = { username: SECRETS.ARMOR_STUDIO_USERNAME, password: SECRETS.ARMOR_STUDIO_PASSWORD };

test("the codes are the ones of RFC 6238 and base32 is reversible", () => {
  // RFC 6238, appendix B: the secret "12345678901234567890" at 59 s gives 94287082 (the last six digits are the code of 6 digits).
  const secret = Buffer.from("12345678901234567890");
  assert.equal(totpCode(secret, stepOf(59_000)), "287082");
  assert.equal(totpCode(secret, stepOf(1_111_111_109_000)), "081804");
  assert.equal(fromBase32(base32(secret)).toString(), secret.toString());
  assert.equal(base32(Buffer.from("foobar")), "MZXW6YTBOI");
});

test("an address is local when it is in the house or the VPN, and remote otherwise", () => {
  const local = parseRanges("192.168.0.0/16,10.0.0.0/8,127.0.0.0/8,::1/128");
  const vpn = parseRanges("10.66.0.0/24");
  assert.equal(classify("192.168.0.14", local, vpn), "local");
  assert.equal(classify("::ffff:192.168.1.5", local, vpn), "local");
  assert.equal(classify("::1", local, vpn), "local");
  assert.equal(classify("203.0.113.9", local, vpn), "remote");
  assert.equal(classify("172.32.0.1", parseRanges("172.16.0.0/12"), []), "remote");
  assert.equal(classify("10.66.0.7", parseRanges("192.168.0.0/16"), vpn), "local");
  assert.equal(inRanges(undefined, local), false);
  assert.throws(() => parseRanges("192.168.0.0/33"), /not an address range/);
  assert.throws(() => parseRanges("nonsense"), /not an address range/);
});

test("from outside the house the session is shorter, can be listed and ended, and critical actions need a new proof", async () => {
  const running = await startServer({ ARMOR_LOCAL_NETWORKS: "10.99.0.0/16" });   // the test client (127.0.0.1) is then "outside"
  try {
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { ...json, "User-Agent": "test-browser/1" }, body: JSON.stringify(credentials) });
    assert.equal(login.status, 201);
    const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    const call = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sessions = await (await call("GET", "/api/v1/studio/sessions")).json() as { sessions: Array<{ origin: string; current: boolean; agent: string; id: string }> };
    assert.equal(sessions.sessions.length >= 1, true);
    assert.deepEqual([sessions.sessions[0]!.origin, sessions.sessions[0]!.current, sessions.sessions[0]!.agent], ["remote", true, "test-browser/1"]);
    const check = await (await call("GET", "/api/v1/remote/check")).json() as { origin: string; session_origin: string };
    assert.deepEqual([check.origin, check.session_origin], ["remote", "remote"]);

    // a critical action: refused until the password is given again, then allowed for a few minutes
    const make = () => call("POST", "/api/v1/users", { username: "visitor", password: "a-long-password-1", role: "viewer" });
    const refused = await make();
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { code: string }).code, "elevation_required");
    assert.equal((await call("POST", "/api/v1/studio/elevate", { password: "wrong" })).status, 401);
    assert.equal((await call("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
    assert.equal((await make()).status, 201);

    // a second session of the same person can be ended from the first
    const other = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    assert.equal(other.status, 201);
    const listed = await (await call("GET", "/api/v1/studio/sessions")).json() as { sessions: Array<{ id: string; current: boolean }> };
    assert.equal(listed.sessions.length, 2);
    const stranger = listed.sessions.find(item => !item.current)!;
    assert.equal((await call("DELETE", `/api/v1/studio/sessions/${stranger.id}`)).status, 204);
    assert.equal(((await (await call("GET", "/api/v1/studio/sessions")).json()) as { sessions: unknown[] }).sessions.length, 1);
    assert.equal((await call("DELETE", "/api/v1/studio/sessions/zzzz")).status, 404);
  } finally { await running.stop(); }
});

test("from inside the house nothing more is asked", async () => {
  const running = await startServer();
  try {
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ username: "family", password: "a-long-password-1", role: "viewer" }) });
    assert.equal(made.status, 201);
  } finally { await running.stop(); }
});

test("the second factor: set up with the password, asked at the next sign-in, recovery codes work once, a code is not replayed", async () => {
  const running = await startServer();
  try {
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    const call = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call("POST", "/api/v1/studio/totp/setup", { password: "wrong" })).status, 401);
    const setup = await (await call("POST", "/api/v1/studio/totp/setup", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).json() as { secret: string; uri: string };
    assert.match(setup.uri, /^otpauth:\/\/totp\/ARMOR:admin\?secret=[A-Z2-7]+&issuer=ARMOR/);
    const secret = fromBase32(setup.secret);
    assert.equal((await call("POST", "/api/v1/studio/totp/enable", { code: "000000" })).status, 401);
    const first = totpCode(secret, stepOf(Date.now()));
    const enabled = await (await call("POST", "/api/v1/studio/totp/enable", { code: first })).json() as { recovery_codes: string[] };
    assert.equal(enabled.recovery_codes.length, 10);
    assert.deepEqual(await (await call("GET", "/api/v1/studio/totp")).json(), { enabled: true, recovery_left: 10, policy: "off" });

    // the next sign-in asks for the code, and does not give a cookie before
    const step1 = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    assert.equal(step1.status, 200);
    assert.equal(step1.headers.getSetCookie().length, 0);
    const { challenge } = await step1.json() as { challenge: string };
    const second = (code: string, token = challenge) => fetch(`${running.base}/api/v1/studio/session/totp`, { method: "POST", headers: json, body: JSON.stringify({ challenge: token, code }) });
    assert.equal((await second("123456")).status, 401);
    // the code that confirmed the set-up cannot be used again; the next one (the next thirty seconds) can
    const replay = await second(first);
    assert.equal(replay.status, 401, "a code is accepted once");
    const next = totpCode(secret, stepOf(Date.now()) + 1);
    const ok = await second(next);
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.getSetCookie().length, 1);

    // a recovery code signs in once
    const again = await (await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).json() as { challenge: string };
    const recovery = enabled.recovery_codes[0]!;
    assert.equal((await second(recovery, again.challenge)).status, 201);
    const third = await (await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).json() as { challenge: string };
    assert.equal((await second(recovery, third.challenge)).status, 401, "a recovery code is used up");

    // turning it off needs the password
    const cookieNow = (ok.headers.getSetCookie()[0] ?? "").split(";")[0];
    const off = (password: string) => fetch(`${running.base}/api/v1/studio/totp`, { method: "DELETE", headers: { ...json, Cookie: cookieNow }, body: JSON.stringify({ password }) });
    assert.equal((await off("wrong")).status, 401);
    assert.equal((await off(SECRETS.ARMOR_STUDIO_PASSWORD)).status, 204);
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).status, 201);
  } finally { await running.stop(); }
});

test("when the policy demands the second factor from outside, a person without it must set it up from inside first", async () => {
  const running = await startServer({ ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_TOTP_REQUIRED: "remote" });
  try {
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    assert.equal(login.status, 403);
    assert.equal(((await login.json()) as { code: string }).code, "totp_setup_required");
  } finally { await running.stop(); }
});

test("the remote policy: from outside, `operate` keeps administering for the house and `view` only looks; inside the house nothing changes", async () => {
  for (const [policy, administering, operating] of [["operate", 403, 200], ["view", 403, 403], ["full", 200, 200]] as const) {
    const running = await startServer({ ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_REMOTE_POLICY: policy });
    try {
      const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
      const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
      const call = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal((await call("GET", "/api/v1/status")).status, 200, `${policy}: looking is always possible`);
      const elevated = await call("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD });
      assert.equal(elevated.status, 200);
      const made = await call("POST", "/api/v1/users", { username: `v${policy}`, password: "a-long-password-1", role: "viewer" });
      assert.equal(made.status === 201 ? 200 : made.status, administering, `${policy}: administering`);
      if (administering === 403) assert.equal(((await made.json()) as { code: string }).code, "remote_policy");
      const armed = await call("POST", "/api/v1/mode", { mode: "armed" });
      assert.equal(armed.status === 403 ? 403 : 200, operating, `${policy}: operating`);
    } finally { await running.stop(); }
  }
  const inside = await startServer({ ARMOR_REMOTE_POLICY: "view" });
  try {
    const login = await fetch(`${inside.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
    const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    const made = await fetch(`${inside.base}/api/v1/users`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ username: "inside", password: "a-long-password-1", role: "viewer" }) });
    assert.equal(made.status, 201);
  } finally { await inside.stop(); }
});

test("a sign-in from outside the house at a new place is told to the places the alarms go to, once, and it can be turned off", async () => {
  for (const [alerts, expected] of [["1", 1], ["0", 0]] as const) {
    const running = await startServer({ ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_LOGIN_ALERTS: alerts });   // the test client (127.0.0.1) is then "outside"
    const sent: Array<{ event: string; login_user?: string; login_from?: string }> = [];
    const original = running.app.context.notifier.send.bind(running.app.context.notifier);
    running.app.context.notifier.send = message => { sent.push(message as never); original(message); };
    try {
      for (let index = 0; index < 2; index += 1) {
        const reply = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
        assert.equal(reply.status, 201);
      }
      const logins = sent.filter(message => message.event === "login.remote");
      assert.equal(logins.length, expected, "the same place is not told twice");
      if (expected) assert.deepEqual([logins[0]!.login_user, logins[0]!.login_from], [SECRETS.ARMOR_STUDIO_USERNAME, "127.0.0.1"]);
    } finally { await running.stop(); }
  }
  // inside the house nothing is told
  const home = await startServer();
  const sent: string[] = [];
  home.app.context.notifier.send = message => { sent.push(message.event); };
  try {
    assert.equal((await fetch(`${home.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).status, 201);
    assert.deepEqual(sent, []);
  } finally { await home.stop(); }
});
