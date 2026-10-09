import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, fieldNodeView, listServices, parseSystemctlShow, parseSystemdTime, serviceFromUnit, stateOf } from "../src/services.js";

const SHOW = `Id=armor-server.service
Description=A.R.M.O.R. server
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled
MainPID=1234
ExecMainStartTimestamp=Wed 2026-10-01 14:41:48 UTC
MemoryCurrent=104857600
NRestarts=0

Id=armor-network.service
LoadState=loaded
ActiveState=failed
SubState=failed
UnitFileState=enabled
MainPID=0
MemoryCurrent=[not set]
NRestarts=3

Id=armor-voice.service
LoadState=not-found
ActiveState=inactive
SubState=dead
UnitFileState=
MainPID=0
`;

test("systemctl show is read unit by unit", () => {
  const units = parseSystemctlShow(SHOW);
  assert.equal(units.size, 3);
  assert.equal(units.get("armor-server.service")?.MainPID, "1234");
});

test("the state is told in the words a person uses", () => {
  const units = parseSystemctlShow(SHOW);
  assert.equal(stateOf(units.get("armor-server.service")), "running");
  assert.equal(stateOf(units.get("armor-network.service")), "failed");
  assert.equal(stateOf(units.get("armor-voice.service")), "not_installed");
  assert.equal(stateOf(undefined), "unknown");
  assert.equal(stateOf({ ActiveState: "active", SubState: "exited" }), "stopped");   // a one-shot that has finished
  assert.equal(stateOf({ ActiveState: "activating" }), "starting");
});

test("a service carries its process, memory, restarts and when it started", () => {
  const units = parseSystemctlShow(SHOW);
  const server = serviceFromUnit(CATALOG[0], units.get("armor-server.service"));
  assert.equal(server.state, "running"); assert.equal(server.pid, 1234); assert.equal(server.memory_bytes, 104857600); assert.equal(server.enabled, true); assert.equal(server.port, 18080);
  assert.equal(server.since_ms, Date.UTC(2026, 9, 1, 14, 41, 48));
  const network = serviceFromUnit(CATALOG.find(entry => entry.id === "network")!, units.get("armor-network.service"));
  assert.equal(network.state, "failed"); assert.equal(network.memory_bytes, null); assert.equal(network.restarts, 3); assert.equal(network.pid, null); assert.equal(network.since_ms, null);
  const missing = serviceFromUnit(CATALOG.find(entry => entry.id === "voice-ai")!, units.get("armor-voice.service"));
  assert.equal(missing.state, "not_installed"); assert.equal(missing.pid, undefined);
});

test("systemd times are read as UTC and nothing else is guessed", () => {
  assert.equal(parseSystemdTime("Wed 2026-10-01 14:41:48 UTC"), Date.UTC(2026, 9, 1, 14, 41, 48));
  assert.equal(parseSystemdTime(""), null); assert.equal(parseSystemdTime("n/a"), null);
});

test("the list has every program of the catalogue and the field nodes, with or without systemd", async () => {
  const withSystemd = await listServices(async () => SHOW, [{ id: "perimetro-1", kind: "radar", online: true, last_ms: 5 }, { id: "meters", kind: "electrical", online: false, last_ms: null }]);
  assert.equal(withSystemd.systemd, true);
  assert.equal(withSystemd.services.length, CATALOG.length + 2);
  assert.equal(withSystemd.services.find(service => service.id === "studio")?.state, "unknown");   // not in the output: systemd said nothing of it
  assert.equal(withSystemd.services.find(service => service.id === "node:radar:perimetro-1")?.state, "online");
  assert.equal(withSystemd.services.find(service => service.id === "node:electrical:meters")?.state, "offline");
  const without = await listServices(async () => null, []);
  assert.equal(without.systemd, false);
  assert.ok(without.services.every(service => service.state === "unknown"));
  assert.equal(fieldNodeView({ id: "a", kind: "radar", online: true, last_ms: 1 }).family, "Field nodes");
});

import { SECRETS, startServer, studioCookie } from "./helpers.js";

test("the services route needs a sign-in and lists the catalogue and the field nodes", async () => {
  const running = await startServer();
  try {
    assert.equal((await fetch(`${running.base}/api/v1/system/services`)).status, 401);
    const cookie = await studioCookie(running.base);
    const ingest = (path: string, body: unknown) => fetch(`${running.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(body) });
    await ingest("/api/v1/health", { node_id: "node-a", timestamp_ms: Date.now(), online: true });
    const body = await (await fetch(`${running.base}/api/v1/system/services`, { headers: { cookie } })).json() as { systemd: boolean; services: Array<{ id: string; family: string; state: string }> };
    assert.equal(typeof body.systemd, "boolean");
    assert.ok(body.services.length >= CATALOG.length + 1);
    assert.ok(CATALOG.every(entry => body.services.some(service => service.id === entry.id)));
    assert.equal(body.services.find(service => service.id === "node:radar:node-a")?.state, "online");
  } finally { await running.stop(); }
});

test("the voice gateway is the unit the installer makes, on the port it listens on", () => {
  const voice = CATALOG.find(entry => entry.id === "voice-ai");
  assert.deepEqual([voice?.unit, voice?.port], ["armor-voice.service", 18090]);
});
