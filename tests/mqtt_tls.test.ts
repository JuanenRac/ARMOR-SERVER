import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import test from "node:test";
import mqttPacket from "mqtt-packet";
import { ConfigError, readConfig } from "../src/config.js";
import { attachMqtt } from "../src/mqtt.js";
import { isTlsUrl, mqttTlsState, parseCaPem, readCaFile } from "../src/mqtt_tls.js";
import { ArmorStore } from "../src/store.js";
import { SECRETS, tempDir } from "./helpers.js";

/** OpenSSL makes the throw-away authorities of these tests; where it is not installed the tests that need it are skipped. */
function opensslAvailable(): boolean {
  try { execFileSync("openssl", ["version"], { stdio: "ignore", env: cleanEnv() }); return true; } catch { return false; }
}
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENSSL_CONF;   // a stray setting must not decide
  return env;
}
const HAVE_OPENSSL = opensslAvailable();
const SKIP = HAVE_OPENSSL ? false : "openssl is not installed";

type Pki = { dir: string; ca: string; otherCa: string; serverKey: string; serverCert: string; caFile: string; otherCaFile: string };
function makePki(): Pki {
  const dir = tempDir();
  const config = path.join(dir, "openssl.cnf");
  fs.writeFileSync(config, "[req]\ndistinguished_name=dn\n[dn]\n");
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe", env: cleanEnv() });
  const authority = (name: string) => run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "2", "-subj", `/CN=${name}`, "-config", config, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  authority("ca");
  authority("other");
  run("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=broker", "-config", config);
  fs.writeFileSync(path.join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n");
  run("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "server.ext");
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
  return { dir, ca: read("ca.pem"), otherCa: read("other.pem"), serverKey: read("server.key"), serverCert: read("server.pem"), caFile: path.join(dir, "ca.pem"), otherCaFile: path.join(dir, "other.pem") };
}

test("a certificate authority file is one certificate in PEM and nothing else", { skip: SKIP }, () => {
  const pki = makePki();
  const parsed = parseCaPem(pki.ca);
  assert.match(parsed.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.match(parsed.subject, /CN=ca/);
  assert.ok(Date.parse(parsed.validTo) > Date.now());
  assert.equal(parseCaPem(pki.ca.replace(/\r?\n/g, "\r\n")).fingerprint256, parsed.fingerprint256, "a file with Windows line ends");
  assert.throws(() => parseCaPem(""), /not one certificate/);
  assert.throws(() => parseCaPem("hello"), /not one certificate/);
  assert.throws(() => parseCaPem(pki.serverKey), /not one certificate/);
  assert.throws(() => parseCaPem(pki.ca + pki.otherCa), /not one certificate/, "a chain: only one authority is trusted");
  assert.throws(() => parseCaPem("note\n" + pki.ca), /not one certificate/);
  assert.throws(() => parseCaPem(pki.ca.replace(/\n[A-Za-z0-9+/]{20}/, "\n!!!!!!!!!!!!!!!!!!!!")), /not a valid certificate/);
  assert.throws(() => parseCaPem(pki.ca, Date.now() + 30 * 86_400_000), /expired/);
  assert.throws(() => parseCaPem(pki.ca, Date.now() - 30 * 86_400_000), /not valid until/);
  assert.equal(readCaFile(pki.caFile).fingerprint256, parsed.fingerprint256);
  assert.throws(() => readCaFile(path.join(pki.dir, "missing.pem")), /cannot be read/);
});

test("the configuration takes an authority only for an mqtts address, and refuses what would leave the link unencrypted", { skip: SKIP }, () => {
  const pki = makePki();
  const base = { ...SECRETS };
  // off by default: nothing about the broker changes
  assert.equal(readConfig({ ...base }).mqtt, null);
  const plain = readConfig({ ...base, ARMOR_MQTT_URL: "mqtt://127.0.0.1:18883" });
  assert.deepEqual(plain.mqtt, { url: "mqtt://127.0.0.1:18883", username: undefined, password: undefined });
  assert.deepEqual(mqttTlsState(plain.mqtt), { configured: true, tls: false, pinned_ca: false });
  assert.deepEqual(mqttTlsState(null), { configured: false, tls: false, pinned_ca: false });
  // on
  const secure = readConfig({ ...base, ARMOR_MQTT_URL: "mqtts://127.0.0.1:8883", ARMOR_MQTT_USERNAME: "armor-server", ARMOR_MQTT_PASSWORD: "x", ARMOR_MQTT_CA_FILE: pki.caFile });
  assert.equal(secure.mqtt?.ca?.pem, parseCaPem(pki.ca).pem);
  const state = mqttTlsState(secure.mqtt);
  assert.equal(state.tls, true);
  assert.equal(state.pinned_ca, true);
  assert.equal(state.ca?.fingerprint256, parseCaPem(pki.ca).fingerprint256);
  assert.ok(!JSON.stringify(state).includes(pki.dir), "no path is shown");
  assert.ok(!JSON.stringify(state).includes("BEGIN"), "no certificate text is shown either: the fingerprint is enough");
  // mqtts without a pinned authority is allowed (the machine's usual authorities)
  assert.equal(readConfig({ ...base, ARMOR_MQTT_URL: "mqtts://broker.example.org:8883" }).mqtt?.ca, undefined);
  assert.equal(isTlsUrl("mqtts://x") && !isTlsUrl("mqtt://x"), true);
  // the mistakes stop the server
  assert.throws(() => readConfig({ ...base, ARMOR_MQTT_URL: "mqtt://127.0.0.1:18883", ARMOR_MQTT_CA_FILE: pki.caFile }), /needs an mqtts:\/\/ address/);
  assert.throws(() => readConfig({ ...base, ARMOR_MQTT_CA_FILE: pki.caFile }), ConfigError);
  assert.throws(() => readConfig({ ...base, ARMOR_MQTT_URL: "mqtts://127.0.0.1:8883", ARMOR_MQTT_CA_FILE: path.join(pki.dir, "nope.pem") }), /cannot be read/);
  fs.writeFileSync(path.join(pki.dir, "junk.pem"), "not a certificate");
  assert.throws(() => readConfig({ ...base, ARMOR_MQTT_URL: "mqtts://127.0.0.1:8883", ARMOR_MQTT_CA_FILE: path.join(pki.dir, "junk.pem") }), ConfigError);
});

/** A broker that only answers the CONNECT of an MQTT client, over TLS: enough to know whether the client trusted it. */
function tlsBroker(pki: Pki): Promise<{ port: number; connects: () => number; close: () => void }> {
  let connects = 0;
  const server = tls.createServer({ key: pki.serverKey, cert: pki.serverCert }, socket => {
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    parser.on("packet", packet => {
      if (packet.cmd === "connect") { ++connects; socket.write(mqttPacket.generate({ cmd: "connack", reasonCode: 0, sessionPresent: false }, { protocolVersion: 5 })); }
    });
    socket.on("data", data => parser.parse(data));
    socket.on("error", () => undefined);
  });
  server.on("tlsClientError", () => undefined);
  return new Promise(resolve => server.listen(0, "0.0.0.0", () => resolve({ port: (server.address() as { port: number }).port, connects: () => connects, close: () => server.close() })));
}
const until = async (condition: () => boolean, ms: number) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); return condition(); };

test("the server connects to a TLS broker whose certificate is signed by the pinned authority", { skip: SKIP }, async () => {
  const pki = makePki();
  const broker = await tlsBroker(pki);
  const client = attachMqtt(new ArmorStore(), `mqtts://127.0.0.1:${broker.port}`, "armor-server", "x", undefined, parseCaPem(pki.ca).pem);
  try {
    assert.equal(await until(() => client.connected, 5000), true, "connected");
    assert.equal(broker.connects(), 1);
  } finally { client.end(true); broker.close(); }
});

test("the server refuses a TLS broker signed by any other authority, and one that is reached by a name its certificate does not vouch for", { skip: SKIP }, async () => {
  const pki = makePki();
  const broker = await tlsBroker(pki);
  // another authority pinned: the certificate of the broker is not signed by it
  const wrong = attachMqtt(new ArmorStore(), `mqtts://127.0.0.1:${broker.port}`, "armor-server", "x", undefined, parseCaPem(pki.otherCa).pem);
  const errors: string[] = [];
  wrong.on("error", error => errors.push(error.message));
  try {
    assert.equal(await until(() => errors.length > 0, 5000), true, "an error was reported");
    assert.match(errors[0] ?? "", /self.signed|unable to (get|verify)|certificate/i, "refused for the certificate");
    assert.equal(wrong.connected, false);
    assert.equal(broker.connects(), 0, "the broker never saw an MQTT client");
  } finally { wrong.end(true); }
  // the right authority, but a name the certificate was not made for (it vouches for 127.0.0.1 and localhost only)
  const hostMismatch = attachMqtt(new ArmorStore(), `mqtts://127.0.0.2:${broker.port}`, "armor-server", "x", undefined, parseCaPem(pki.ca).pem);
  const mismatchErrors: string[] = [];
  hostMismatch.on("error", error => mismatchErrors.push(error.message));
  try {
    assert.equal(await until(() => mismatchErrors.length > 0, 5000), true);
    assert.match(mismatchErrors[0] ?? "", /not in the cert|altname|Hostname\/IP/i, "refused for the name, not for lack of a broker");
    assert.equal(hostMismatch.connected, false);
    assert.equal(broker.connects(), 0);
  } finally { hostMismatch.end(true); broker.close(); }
});
