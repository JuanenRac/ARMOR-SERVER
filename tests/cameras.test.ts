import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { approvedCameraEndpoint, isPtzCommand, onvifTag, xmlEscape, xmlUnescape } from "../src/cameras/ptz.js";
import { DiscoveryGate, discoveryPrefixes, isPrivateIpv4, scanNetworks } from "../src/cameras/discovery.js";
import { cameraPublic, cameraView, parseCameraInput, rtspUrl, type CameraConnection } from "../src/cameras/model.js";
import { discoverRtspPaths } from "../src/cameras/rtsp.js";
import { CameraVault, decryptSecrets, encryptSecrets } from "../src/cameras/vault.js";
import { tempDir } from "./helpers.js";
import { createHash } from "node:crypto";

const key = (secret: string) => createHash("sha256").update(`armor-camera-config/v1\0${secret}`).digest();
const base = { id: "cam-1", name: "Gate", host: "192.168.0.203", username: "admin", password: "s3cret", rtspPath: "/live", onvifPort: 80, rtspPort: 554 };

test("camera input is validated strictly", () => {
  assert.ok(parseCameraInput(base));
  for (const bad of [null, "x", {}, { ...base, id: "a" }, { ...base, id: "has space" }, { ...base, host: "bad host" }, { ...base, host: "a".repeat(254) }, { ...base, name: "" }]) {
    assert.equal(parseCameraInput(bad), null);
  }
  const camera = parseCameraInput({ ...base, onvifPort: 99999, rtspPort: "554", rtspPath: "///live" })!;
  assert.equal(camera.onvifPort, 80);
  assert.equal(camera.rtspPort, 554);
  assert.equal(camera.rtspPath, "live");
});

test("editing a camera keeps the stored password unless a new one is entered", () => {
  const stored = parseCameraInput(base)!;
  assert.equal(parseCameraInput({ ...base, password: "" }, stored)!.secrets?.password, "s3cret");
  assert.equal(parseCameraInput({ ...base, username: "", password: "" }, stored)!.secrets?.password, "s3cret");
  assert.equal(parseCameraInput({ ...base, password: "new" }, stored)!.secrets?.password, "new");
  assert.equal(parseCameraInput({ ...base, username: "other", password: "" }, stored), null);
  assert.equal(parseCameraInput({ ...base, username: "", password: "new" }, stored)!.secrets?.username, "admin");
  assert.equal(parseCameraInput({ ...base, username: "", password: "new" }), null);
});

test("public projections never expose the password, and views hide the username too", () => {
  const camera = parseCameraInput(base)!;
  const operatorView = cameraPublic(camera, true);
  assert.equal(operatorView.username, "admin");
  assert.equal(operatorView.hasCredentials, true);
  assert.equal(operatorView.liveVideoAvailable, true);
  assert.doesNotMatch(JSON.stringify(operatorView), /s3cret/);
  const viewer = cameraView(camera, false);
  assert.equal("username" in viewer, false);
  assert.equal(viewer.liveVideoAvailable, false);
  assert.doesNotMatch(JSON.stringify(viewer), /s3cret|admin/);
});

test("the RTSP URL is built only from a complete credential pair and encodes special characters", () => {
  const camera = parseCameraInput({ ...base, username: "ad min", password: "p@ss/word" })!;
  assert.equal(rtspUrl(camera), "rtsp://ad%20min:p%40ss%2Fword@192.168.0.203:554/live");
  assert.equal(rtspUrl({ ...camera, secrets: undefined }), null);
  assert.equal(rtspUrl({ ...camera, rtspPath: "" }), null);
});

test("stored secrets round-trip and are unreadable with another key", () => {
  const sealed = encryptSecrets({ username: "u", password: "p" }, key("one"));
  assert.doesNotMatch(JSON.stringify(sealed), /"p"|password/);
  assert.deepEqual(decryptSecrets(sealed, key("one")), { username: "u", password: "p" });
  assert.equal(decryptSecrets(sealed, key("two")), undefined);
  assert.equal(decryptSecrets({ ...sealed, tag: Buffer.alloc(16).toString("base64") }, key("one")), undefined);
});

test("the vault persists across restarts without writing a password in clear", () => {
  const file = path.join(tempDir(), "cameras.json");
  const first = new CameraVault({ file, secret: "k".repeat(40) });
  first.save(parseCameraInput(base)!);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /s3cret/);
  const second = new CameraVault({ file, secret: "k".repeat(40) });
  assert.equal(second.get("cam-1")?.secrets?.password, "s3cret");
  assert.equal(second.remove("cam-1"), true);
  assert.equal(new CameraVault({ file, secret: "k".repeat(40) }).list().length, 0);
});

test("a camera encrypted with the old control token migrates once to the dedicated key", () => {
  const file = path.join(tempDir(), "cameras.json");
  const legacy = new CameraVault({ file, secret: "c".repeat(32) });
  legacy.save(parseCameraInput(base)!);
  const warnings: string[] = [];
  const migrated = new CameraVault({ file, secret: "k".repeat(40), legacySecret: "c".repeat(32), warn: message => warnings.push(message) });
  assert.equal(migrated.get("cam-1")?.secrets?.password, "s3cret");
  assert.ok(warnings.some(message => message.includes("MIGRATED")));
  // After migration the dedicated key alone is enough.
  assert.equal(new CameraVault({ file, secret: "k".repeat(40) }).get("cam-1")?.secrets?.password, "s3cret");
});

test("a camera whose key changed is kept without credentials and reported", () => {
  const file = path.join(tempDir(), "cameras.json");
  new CameraVault({ file, secret: "a".repeat(32) }).save(parseCameraInput(base)!);
  const warnings: string[] = [];
  const reopened = new CameraVault({ file, secret: "b".repeat(32), warn: message => warnings.push(message) });
  assert.equal(reopened.get("cam-1")?.secrets, undefined);
  assert.ok(warnings.some(message => message.includes("UNREADABLE")));
});

test("PTZ commands are an allow-list", () => {
  for (const command of ["left", "right", "up", "down", "zoomIn", "zoomOut", "stop"]) assert.equal(isPtzCommand(command), true);
  for (const command of ["reboot", "", 5, null, "LEFT", "left;rm"]) assert.equal(isPtzCommand(command), false);
});

test("an ONVIF address must stay on the configured camera host", () => {
  const camera = { host: "192.168.0.203" };
  assert.equal(approvedCameraEndpoint(camera, "http://192.168.0.203/onvif/ptz"), "http://192.168.0.203/onvif/ptz");
  assert.throws(() => approvedCameraEndpoint(camera, "http://192.168.0.99/onvif/ptz"), /outside its configured host/);
  assert.throws(() => approvedCameraEndpoint(camera, "http://evil.example/x"), /outside/);
  assert.throws(() => approvedCameraEndpoint(camera, "ftp://192.168.0.203/x"), /outside/);
  assert.throws(() => approvedCameraEndpoint(camera, "not a url"), /invalid ONVIF endpoint/);
});

test("XML helpers escape and read back safely", () => {
  assert.equal(xmlEscape(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  assert.equal(xmlUnescape(xmlEscape(`a<b>&"c'`)), `a<b>&"c'`);
  assert.equal(onvifTag("<tt:XAddr>http://h/media</tt:XAddr>", "XAddr"), "http://h/media");
  assert.equal(onvifTag("<none/>", "XAddr"), null);
});

test("discovery scans only private networks and reports the ports it found", async () => {
  assert.equal(isPrivateIpv4("192.168.1.5"), true);
  assert.equal(isPrivateIpv4("172.20.0.1"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.deepEqual(discoveryPrefixes("192.168.7.0/24"), ["192.168.7"]);
  assert.throws(() => discoveryPrefixes("8.8.8.0/24"), /private/);
  const interfaces = { eth0: [{ family: "IPv4", internal: false, address: "10.1.2.3" }, { family: "IPv4", internal: true, address: "127.0.0.1" }, { family: "IPv4", internal: false, address: "8.8.4.4" }] } as never;
  assert.deepEqual(discoveryPrefixes(null, interfaces), ["10.1.2"]);
  const found = await scanNetworks({ prefixes: ["10.1.2"], probe: async (host, port) => host === "10.1.2.9" && (port === 80 || port === 554) });
  assert.deepEqual(found, [{ host: "10.1.2.9", ports: [80, 554] }]);
});

test("a discovery can be cancelled and only one runs at a time", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await scanNetworks({ prefixes: ["10.1.2"], signal: controller.signal, probe: async () => true }), []);
  const gate = new DiscoveryGate();
  let release!: () => void;
  const first = gate.run(() => new Promise<string>(resolve => { release = () => resolve("done"); }));
  assert.equal(await gate.run(async () => "second"), "busy");
  release();
  assert.equal(await first, "done");
  assert.equal(await gate.run(async () => "third"), "third");
});

test("RTSP discovery keeps every path that answers 200 and needs credentials", async () => {
  const camera = parseCameraInput(base)!;
  const found = await discoverRtspPaths(camera, ["/a", "/b", "/c"], 0, async (_camera, candidate) => candidate === "/b" ? 401 : 200);
  assert.deepEqual(found, ["/a", "/c"]);
  assert.deepEqual(await discoverRtspPaths({ ...camera, secrets: undefined }, ["/a"], 0), []);
});

test("a camera can have a lighter stream for the live picture, which only the live picture uses", () => {
  const camera = parseCameraInput({ id: "gate-cam", name: "Gate", host: "192.168.0.203", username: "u", password: "p", rtspPath: "/11", previewPath: "//12" })!;
  assert.equal(camera.previewPath, "12");
  assert.match(rtspUrl(camera)!, /\/11$/, "recordings and snapshots keep the main stream");
  assert.match(rtspUrl(camera, true)!, /\/12$/, "the live picture uses the lighter one");
  const plain = parseCameraInput({ id: "gate-cam", name: "Gate", host: "192.168.0.203", username: "u", password: "p", rtspPath: "11" })!;
  assert.match(rtspUrl(plain, true)!, /\/11$/, "without a lighter stream the live picture uses the main one");
});
