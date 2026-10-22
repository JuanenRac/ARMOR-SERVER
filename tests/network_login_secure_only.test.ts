import assert from "node:assert/strict";
import test from "node:test";
import { nodeTokenFor } from "../src/http/node_token.js";
import { arrivedSecurely } from "../src/routes/network.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const NOW = 1_790_000_000_000;
const state = () => ({
  kind: "network", node_id: "network-1", timestamp_ms: NOW, interface: { name: "eth0", ip: "192.168.0.10", cidr: "192.168.0.0/24", gateway: "192.168.0.1" },
  internet: { state: "up", latency_ms: 12 }, devices: [{ id: "aa:bb:cc:00:00:01", ip: "192.168.0.50", mac: "aa:bb:cc:00:00:01", online: true, first_seen_ms: NOW - 5_000, last_seen_ms: NOW }],
});

test("a request counts as secure when it came over TLS or straight from this machine, and not when a proxy forwarded it", () => {
  assert.equal(arrivedSecurely({ secure: true, headers: {}, socket: { remoteAddress: "192.168.0.7" } }), true);
  assert.equal(arrivedSecurely({ secure: false, headers: {}, socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(arrivedSecurely({ secure: false, headers: {}, socket: { remoteAddress: "::1" } }), true);
  assert.equal(arrivedSecurely({ secure: false, headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(arrivedSecurely({ secure: false, headers: {}, socket: { remoteAddress: "192.168.0.7" } }), false, "plain HTTP from the network");
  assert.equal(arrivedSecurely({ secure: false, headers: { "x-forwarded-for": "192.168.0.7" }, socket: { remoteAddress: "127.0.0.1" } }), false, "a proxy on this machine forwarding a plain request");
  assert.equal(arrivedSecurely({ secure: false, headers: { forwarded: "for=192.168.0.7" }, socket: { remoteAddress: "127.0.0.1" } }), false);
  assert.equal(arrivedSecurely({ headers: {} }), false, "nothing known");
});

test("with the option on, the stored login of a device is not handed to a node whose request was not secure; off (the default) it is, as before", async () => {
  const running = await startServer();
  try {
    const nodeToken = nodeTokenFor(SECRETS.ARMOR_INGEST_TOKEN, "network-1");
    const ingest = (extra: Record<string, string> = {}) => fetch(`${running.base}/api/v1/network/state`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}`, ...extra }, body: JSON.stringify(state()) });
    assert.equal((await ingest()).status, 202);
    const cookie = await studioCookie(running.base);
    const headers = { "Content-Type": "application/json", cookie };
    assert.equal((await fetch(`${running.base}/api/v1/network/devices/aa:bb:cc:00:00:01/login`, { method: "PUT", headers, body: JSON.stringify({ user: "admin", password: "camera-password" }) })).status, 200);
    const ask = async () => {
      const queued = await fetch(`${running.base}/api/v1/network/commands`, { method: "POST", headers, body: JSON.stringify({ type: "inspect", device_id: "aa:bb:cc:00:00:01", login: true }) });
      assert.equal(queued.status, 202);
    };
    const sealedIn = (answer: { commands: Array<{ auth_sealed?: string }> }) => answer.commands.map(command => typeof command.auth_sealed === "string");
    // the option is off: the login goes, whatever the way the node came in
    await ask();
    assert.deepEqual(sealedIn(await (await ingest({ "X-Forwarded-For": "192.168.0.7" })).json() as never), [true]);
    // on: from this machine it still goes; forwarded from the network (not secure) it does not, and the node looks without one
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers, body: JSON.stringify({ "network.login_secure_only": true }) })).status, 200);
    await ask();
    assert.deepEqual(sealedIn(await (await ingest({ "X-Forwarded-For": "192.168.0.7" })).json() as never), [false]);
    await ask();
    assert.deepEqual(sealedIn(await (await ingest()).json() as never), [true]);
    // and the audit trail says that the option was changed
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { headers: { cookie } }).then(reply => reply.json()) as { settings: Record<string, unknown> }).settings["network.login_secure_only"], true);
  } finally { await running.stop(); }
});
