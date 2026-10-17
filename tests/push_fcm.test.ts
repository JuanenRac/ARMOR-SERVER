import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FcmDevices, FcmFull, FcmInvalid, MAX_PER_USER, fcmChannel, fcmChannelFor, parseServiceAccount, signedAssertion, type FcmServiceAccount } from "../src/push_fcm.js";
import { startServer, studioCookie } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account: FcmServiceAccount = { project_id: "armor-test-1", client_email: "push@armor-test-1.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.googleapis.com/token" };
const TOKEN_A = "a".repeat(30) + ":APA91bHexample";
const TOKEN_B = "b".repeat(40);
const devicesFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-fcm-")), "devices.json");

test("a service account is read strictly", () => {
  assert.equal(parseServiceAccount(JSON.stringify(account)).project_id, "armor-test-1");
  for (const bad of ["not json", "[]", JSON.stringify({ ...account, project_id: "" }), JSON.stringify({ ...account, private_key: "nope" }), JSON.stringify({ ...account, token_uri: "http://x" }), JSON.stringify({ ...account, project_id: "Has Spaces" })]) {
    assert.throws(() => parseServiceAccount(bad), FcmInvalid, bad.slice(0, 40));
  }
});

test("the request for an access token is a JWT signed with the key of the service account", () => {
  const jwt = signedAssertion(account, 1_000_000).split(".");
  assert.equal(jwt.length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claim = JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()) as Record<string, unknown>;
  assert.equal(claim.iss, account.client_email);
  assert.equal(claim.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claim.exp, 1_003_600);
  assert.ok(createVerify("RSA-SHA256").update(`${jwt[0]}.${jwt[1]}`).verify(publicKey, Buffer.from(jwt[2]!, "base64url")));
});

test("the phones are kept, deduplicated, limited and forgotten", () => {
  const file = devicesFile();
  const devices = new FcmDevices(file);
  assert.equal(devices.add(TOKEN_A), true);
  assert.equal(devices.add(TOKEN_A), false);
  assert.equal(devices.add(TOKEN_B), true);
  assert.equal(new FcmDevices(file).count(), 2);
  assert.throws(() => devices.add("short"), FcmInvalid);
  assert.throws(() => devices.add(5), FcmInvalid);
  assert.equal(devices.remove(TOKEN_A), true);
  assert.equal(devices.remove(TOKEN_A), false);
  assert.deepEqual(new FcmDevices(file).list(), [TOKEN_B]);
  for (let i = 0; i < 60; i += 1) devices.add(`t${String(i).padStart(2, "0")}${"x".repeat(25)}`);
  assert.equal(devices.count(), 50);
});

test("an alarm is sent to every registered phone with one access token, and a phone that Firebase says is gone is dropped", async () => {
  const devices = new FcmDevices(devicesFile());
  devices.add(TOKEN_A); devices.add(TOKEN_B);
  const calls: Array<{ url: string; body: string; auth?: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    calls.push({ url: address, body: String(init?.body), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (address === account.token_uri) return new Response(JSON.stringify({ access_token: "ya29.token", expires_in: 3600 }), { status: 200 });
    const message = JSON.parse(String(init?.body)) as { message: { token: string } };
    return message.message.token === TOKEN_B ? new Response("{}", { status: 404 }) : new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const channel = fcmChannel({ account, devices, fetchImpl, now: () => 5_000_000 });
  const first = await channel.deliver({ event: "alarm.raised", severity: "critical" } as never, "Door open", "en", AbortSignal.timeout(5000));
  assert.equal(first.ok, true);
  assert.equal(first.detail, "1 phone(s)");
  assert.deepEqual(devices.list(), [TOKEN_A]);   // the phone that was gone is dropped
  assert.equal(calls.filter(call => call.url === account.token_uri).length, 1);
  const sent = calls.find(call => call.url.includes("messages:send"));
  assert.ok(sent?.url.startsWith("https://fcm.googleapis.com/v1/projects/armor-test-1/"));
  assert.equal(sent?.auth, "Bearer ya29.token");
  const body = JSON.parse(sent!.body) as { message: { android: { priority: string; notification: { channel_id: string } }; notification: { body: string } } };
  assert.equal(body.message.android.priority, "HIGH");
  assert.equal(body.message.android.notification.channel_id, "armor_alarm_critical");   // the channel the Android app creates
  assert.equal(body.message.notification.body, "Door open");
  await channel.deliver({ event: "alarm.raised", severity: "warning" } as never, "Battery low", "en", AbortSignal.timeout(5000));
  assert.equal(calls.filter(call => call.url === account.token_uri).length, 1);   // the access token is reused
});

test("the notification channel is one that the Android app has", () => {
  assert.equal(fcmChannelFor({ severity: "critical", event: "alarm.raised" }), "armor_alarm_critical");
  assert.equal(fcmChannelFor({ severity: "warning", event: "alarm.raised" }), "armor_alarm_warning");
  assert.equal(fcmChannelFor({ severity: "high", event: "alert.raised" }), "armor_alarm");
  assert.equal(fcmChannelFor({ event: "alert.raised" }), "armor_alarm");
  assert.equal(fcmChannelFor({ severity: "warning", event: "alarm.escalated" }), "armor_alarm_critical", "an unattended alarm is always loud");
});

test("a phone belongs to the person who registered it, and leaves with them", () => {
  const file = devicesFile();
  const devices = new FcmDevices(file);
  assert.equal(devices.add(TOKEN_A, "ana"), true);
  assert.equal(devices.add(TOKEN_B, "luis"), true);
  assert.equal(devices.forUser("ana"), 1);
  assert.deepEqual(new FcmDevices(file).entries().map(entry => [entry.token, entry.user]), [[TOKEN_A, "ana"], [TOKEN_B, "luis"]], "the binding is kept in the file");
  assert.equal(devices.removeUser("ana"), 1);
  assert.deepEqual(devices.list(), [TOKEN_B]);
  assert.equal(devices.removeUser(""), 0, "phones with no person are not removed by an empty name");
  devices.rename("luis", "luisa");
  assert.equal(devices.forUser("luisa"), 1);
  // a token registered again by somebody else is theirs now
  assert.equal(devices.add(TOKEN_B, "ana"), false);
  assert.equal(devices.forUser("ana"), 1);
  assert.equal(devices.forUser("luisa"), 0);
});

test("one person cannot push the others' phones out, and a full list is not emptied", () => {
  const devices = new FcmDevices(devicesFile());
  const token = (n: number) => `tok${String(n).padStart(3, "0")}${"y".repeat(25)}`;
  for (let i = 0; i < 20; i += 1) devices.add(token(i), "viewer");
  assert.equal(devices.forUser("viewer"), MAX_PER_USER, "a person has a few phones");
  assert.deepEqual(devices.list(), [15, 16, 17, 18, 19].map(token), "the oldest of theirs make room");
  const others = new FcmDevices(devicesFile());
  for (let i = 0; i < 50; i += 1) others.add(token(i), `user${i}`);
  assert.equal(others.count(), 50);
  assert.throws(() => others.add(token(99), "late"), FcmFull);
  assert.equal(others.count(), 50, "nobody else's phone was dropped");
});

test("the phones of the old format (bare tokens) are still read, with no person", () => {
  const file = devicesFile();
  fs.writeFileSync(file, JSON.stringify([TOKEN_A, TOKEN_B]));
  const devices = new FcmDevices(file);
  assert.deepEqual(devices.list(), [TOKEN_A, TOKEN_B]);
  assert.deepEqual(devices.entries().map(entry => entry.user), ["", ""]);
  devices.add(TOKEN_A, "ana");
  assert.equal(devices.forUser("ana"), 1);
});

test("a retry sends the message only to the phones that did not get it", async () => {
  const devices = new FcmDevices(devicesFile());
  devices.add(TOKEN_A); devices.add(TOKEN_B);
  const sentTo: string[] = [];
  let failB = true;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === account.token_uri) return new Response(JSON.stringify({ access_token: "ya29.token", expires_in: 3600 }), { status: 200 });
    const token = (JSON.parse(String(init?.body)) as { message: { token: string } }).message.token;
    sentTo.push(token);
    if (token === TOKEN_B && failB) return new Response("{}", { status: 503 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const channel = fcmChannel({ account, devices, fetchImpl, now: () => 5_000_000 });
  const message = { event: "alarm.raised", severity: "critical" } as never;
  const first = await channel.deliver(message, "Smoke", "en", AbortSignal.timeout(5000));
  assert.equal(first.ok, false);
  assert.equal(first.final, false, "a 503 is worth another try");
  failB = false;
  const second = await channel.deliver(message, "Smoke", "en", AbortSignal.timeout(5000));
  assert.equal(second.ok, true);
  assert.deepEqual(sentTo, [TOKEN_A, TOKEN_B, TOKEN_B], "the phone that already had it is not sent the same alarm again");
});

test("a token that Firebase calls not a registration token is dropped, a bad request about the message is not", async () => {
  const devices = new FcmDevices(devicesFile());
  devices.add(TOKEN_A); devices.add(TOKEN_B);
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === account.token_uri) return new Response(JSON.stringify({ access_token: "ya29.token", expires_in: 3600 }), { status: 200 });
    const token = (JSON.parse(String(init?.body)) as { message: { token: string } }).message.token;
    return token === TOKEN_A
      ? new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }), { status: 400 })
      : new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload" } }), { status: 400 });
  }) as unknown as typeof fetch;
  const result = await fcmChannel({ account, devices, fetchImpl }).deliver({ event: "alarm.raised", severity: "warning" } as never, "x", "en", AbortSignal.timeout(5000));
  assert.deepEqual(devices.list(), [TOKEN_B], "only the token that is not a registration token is dropped");
  assert.equal(result.ok, false);
  assert.equal(result.final, true, "a malformed request will not get better");
});

test("with no phones registered nothing is asked of Firebase, and a refused token request is a failure", async () => {
  let asked = 0;
  const fetchImpl = (async () => { asked += 1; return new Response("{}", { status: 401 }); }) as unknown as typeof fetch;
  const empty = fcmChannel({ account, devices: new FcmDevices(devicesFile()), fetchImpl });
  assert.equal((await empty.deliver({ event: "alarm.raised" } as never, "x", "en", AbortSignal.timeout(5000))).ok, true);
  assert.equal(asked, 0);
  const devices = new FcmDevices(devicesFile());
  devices.add(TOKEN_A);
  const refused = await fcmChannel({ account, devices, fetchImpl }).deliver({ event: "alarm.raised" } as never, "x", "en", AbortSignal.timeout(5000));
  assert.equal(refused.ok, false);
});

test("push is off by default: a phone cannot register, and the status says so", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    const status = await (await fetch(`${running.base}/api/v1/push/status`, { headers: admin })).json() as { enabled: boolean; devices: number };
    assert.deepEqual(status, { enabled: false, devices: 0 });
    assert.equal((await fetch(`${running.base}/api/v1/push/register`, { method: "POST", headers: admin, body: JSON.stringify({ token: TOKEN_A }) })).status, 409);
    assert.equal((await fetch(`${running.base}/api/v1/push/register`, { method: "POST", body: JSON.stringify({ token: TOKEN_A }), headers: { "Content-Type": "application/json" } })).status, 401);
    // a phone can take its token back by POST too (some HTTP stacks send no body with DELETE), and only with a session
    assert.equal((await fetch(`${running.base}/api/v1/push/unregister`, { method: "POST", headers: admin, body: JSON.stringify({ token: TOKEN_A }) })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/push/unregister`, { method: "POST", body: JSON.stringify({ token: TOKEN_A }), headers: { "Content-Type": "application/json" } })).status, 401);
  } finally { await running.stop(); }
});
