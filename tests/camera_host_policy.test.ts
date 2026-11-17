// Where the server may connect on behalf of a camera: anywhere while cameras.allow_public_hosts is on (the default), only to addresses of the house when it is off.
import assert from "node:assert/strict";
import test from "node:test";
import { cameraHostAllowed, cameraTarget, checkedLookup, isHouseAddress, setCameraHostPolicy } from "../src/cameras/host_policy.js";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };

test("only the private ranges of the house count as the house", () => {
  for (const yes of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.0.203", "fd12:3456::1", "fc00::1", "::ffff:192.168.1.5", "[fd00::2]"]) assert.equal(isHouseAddress(yes), true, yes);
  for (const no of ["127.0.0.1", "169.254.169.254", "172.15.0.1", "172.32.0.1", "8.8.8.8", "192.169.0.1", "::1", "fe80::1", "2001:db8::1", "::ffff:8.8.8.8", "localhost", "cam.example.com", ""]) assert.equal(isHouseAddress(no), false, no);
});

test("while public hosts are allowed nothing changes; with the option off a connection to an address outside the house is refused", async () => {
  try {
    setCameraHostPolicy(() => true);
    assert.deepEqual(cameraTarget("8.8.8.8", 554), { host: "8.8.8.8", port: 554 });
    assert.equal(await cameraHostAllowed("127.0.0.1"), true);
    setCameraHostPolicy(() => false);
    assert.deepEqual(cameraTarget("192.168.0.9", 554), { host: "192.168.0.9", port: 554 });
    for (const outside of ["127.0.0.1", "169.254.169.254", "8.8.8.8", "::1"]) {
      const target = cameraTarget(outside, 554);
      assert.equal(target.host, "refused.invalid", outside);
      await assert.rejects(new Promise((resolve, reject) => target.lookup!(target.host, {}, (error, address) => (error ? reject(error) : resolve(address)))), { code: "EACCES" });
    }
    assert.equal(typeof cameraTarget("camera.local", 554).lookup, "function", "a name is checked on the address it resolves to");
    assert.equal(await cameraHostAllowed("192.168.0.9"), true);
    for (const outside of ["127.0.0.1", "169.254.169.254", "8.8.8.8"]) assert.equal(await cameraHostAllowed(outside), false, outside);
    await assert.rejects(new Promise((resolve, reject) => checkedLookup("localhost", {}, (error, address) => (error ? reject(error) : resolve(address)))), { code: "EACCES" }, "the name that resolves to the loopback is refused");
  } finally { setCameraHostPolicy(() => true); }
});

test("the option is on by default and turning it on again is told as a loss", () => {
  assert.equal(SECURITY_DEFAULTS["cameras.allow_public_hosts"], true);
  assert.equal(lowers("cameras.allow_public_hosts", true, false), false);
  assert.equal(lowers("cameras.allow_public_hosts", false, true), true);
});

test("saving a camera: any address is taken by default, and with the option off only an address of the house", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const save = (host: string) => fetch(`${running.base}/api/v1/cameras/configure`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ id: "cam-1", name: "Gate", host, username: "admin", password: "s3cret", rtspPath: "live", onvifPort: 80, rtspPort: 554 }) });
    assert.equal((await save("127.0.0.1")).status, 200, "as it always was");
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ "cameras.allow_public_hosts": false }) })).status, 200);
    for (const outside of ["127.0.0.1", "169.254.169.254", "8.8.8.8"]) {
      const refused = await save(outside);
      assert.deepEqual([refused.status, ((await refused.json()) as { code: string }).code], [422, "camera_host_not_private"], outside);
    }
    assert.equal((await save("192.168.0.203")).status, 200);
  } finally { setCameraHostPolicy(() => true); await running.stop(); }
});
