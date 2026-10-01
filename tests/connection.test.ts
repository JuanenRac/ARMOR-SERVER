import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkConnection, originsWithStudioPort, readConnection, writeConnection } from "../src/connection.js";
import { tempDir } from "./helpers.js";

test("a proposed address and ports are checked before they are kept", () => {
  assert.deepEqual(checkConnection({ host: "0.0.0.0", port: 18080, studio_port: 18081 }), { ok: true, value: { host: "0.0.0.0", port: 18080, studio_port: 18081 } });
  assert.deepEqual(checkConnection({ host: "", port: "" }), { ok: true, value: {} });
  for (const bad of [{ host: "999.1.1.1" }, { host: "example.com" }, { port: 0 }, { port: 70000 }, { port: 1.5 }, { studio_port: "x" }, { port: 8080, studio_port: 8080 }, [], null]) assert.equal(checkConnection(bad).ok, false, JSON.stringify(bad));
});

test("the saved setting is read back, and a broken file is ignored instead of stopping the server", () => {
  const dir = tempDir();
  assert.deepEqual(readConnection(dir), {});
  writeConnection(dir, { host: "192.168.0.5", port: 18080 });
  assert.deepEqual(readConnection(dir), { host: "192.168.0.5", port: 18080 });
  fs.writeFileSync(path.join(dir, "connection.json"), "{ not json");
  assert.deepEqual(readConnection(dir), {});
  fs.writeFileSync(path.join(dir, "connection.json"), JSON.stringify({ port: 99999 }));
  assert.deepEqual(readConnection(dir), {});
});

test("Studio keeps being allowed once its port was changed", () => {
  assert.deepEqual(originsWithStudioPort(["http://127.0.0.1:5178", "http://192.168.0.180:18081"], 19000).sort(), ["http://127.0.0.1:5178", "http://192.168.0.180:18081", "http://192.168.0.180:19000"]);
  assert.deepEqual(originsWithStudioPort(["http://a:1"], undefined), ["http://a:1"]);
});
