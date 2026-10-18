// Per-account interface preferences: what is kept, what is refused, that each person has their own, and that a damaged file never stops the server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PreferencesStore } from "../src/preferences.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

const place = { name: "Madrid", region: "Madrid", country: "ES", lat: 40.4, lon: -3.7 };

test("preferences merge field by field, survive a restart, and are never shared between people", () => {
  const file = path.join(tempDir(), "preferences.json");
  const store = new PreferencesStore(file);
  assert.deepEqual(store.get("nobody"), {});
  store.update("a", { language: "pt", theme: "Dark Blue" });
  store.update("a", { weatherPlace: place });
  store.update("b", { language: "ja" });
  assert.deepEqual(store.get("a"), { language: "pt", theme: "Dark Blue", weatherPlace: place });
  assert.deepEqual(store.get("b"), { language: "ja" });
  store.update("a", { weatherPlace: null });
  assert.equal(store.get("a").weatherPlace, null, "null means no place chosen");
  const reopened = new PreferencesStore(file);
  assert.deepEqual(reopened.get("a"), { language: "pt", theme: "Dark Blue", weatherPlace: null });
  assert.deepEqual(reopened.get("b"), { language: "ja" });
});

test("a bad language, theme or place is refused with its own reason and changes nothing", () => {
  const store = new PreferencesStore(path.join(tempDir(), "preferences.json"));
  store.update("a", { language: "es" });
  for (const language of ["", "esp", "ES", "e", 5, null, {}]) assert.throws(() => store.update("a", { language }), /invalid_language/, JSON.stringify(language));
  for (const theme of ["", "x".repeat(25), "dark;drop", "dark/../", 7, null]) assert.throws(() => store.update("a", { theme }), /invalid_theme/, JSON.stringify(theme));
  const bad = ["Madrid", 3, [], { ...place, lat: "40" }, { ...place, lon: NaN }, { ...place, lat: Infinity }, { ...place, lat: 91 }, { ...place, lon: -180.5 }, { ...place, name: 1 }, { name: "x" }];
  for (const weatherPlace of bad) assert.throws(() => store.update("a", { weatherPlace }), /invalid_weather_place/, JSON.stringify(weatherPlace));
  assert.deepEqual(store.get("a"), { language: "es" });
});

test("a place keeps its coordinates but its text is cut to a sane length", () => {
  const store = new PreferencesStore(path.join(tempDir(), "preferences.json"));
  const saved = store.update("a", { weatherPlace: { ...place, name: "n".repeat(500), region: "r".repeat(500), country: "c".repeat(500), extra: "ignored" } }).weatherPlace!;
  assert.deepEqual([saved.name.length, saved.region.length, saved.country.length], [120, 120, 120]);
  assert.deepEqual(Object.keys(saved).sort(), ["country", "lat", "lon", "name", "region"]);
});

test("a damaged, foreign or half-valid file is ignored entry by entry and never throws", () => {
  const dir = tempDir();
  const file = path.join(dir, "preferences.json");
  for (const content of ["", "{", "[]", "null", JSON.stringify({ schema: 2, users: { a: { language: "es" } } }), JSON.stringify({ schema: 1 }), JSON.stringify({ schema: 1, users: "x" })]) {
    fs.writeFileSync(file, content);
    assert.deepEqual(new PreferencesStore(file).get("a"), {}, content);
  }
  fs.writeFileSync(file, JSON.stringify({ schema: 1, users: { a: { language: "zzz", theme: "Light", weatherPlace: { name: "x" } }, b: null, c: "text", d: { language: "fr", weatherPlace: null } } }));
  const store = new PreferencesStore(file);
  assert.deepEqual(store.get("a"), { theme: "Light" }, "only the valid fields of an entry survive");
  assert.deepEqual(store.get("b"), {});
  assert.deepEqual(store.get("c"), {});
  assert.deepEqual(store.get("d"), { language: "fr", weatherPlace: null });
});

test("an unwritable folder only means the preferences are not kept: the update still answers", () => {
  const dir = tempDir();
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  const store = new PreferencesStore(path.join(blocker, "inside", "preferences.json"));
  assert.deepEqual(store.update("a", { language: "de" }), { language: "de" });
});

test("over HTTP: no session, no preferences; a signed-in person reads and writes their own; a bad value is a 400 with the reason", async () => {
  const running = await startServer();
  try {
    const json = { "Content-Type": "application/json" };
    assert.equal((await fetch(`${running.base}/api/v1/preferences`)).status, 401);
    assert.equal((await fetch(`${running.base}/api/v1/preferences`, { method: "PUT", headers: json, body: "{}" })).status, 401);
    const headers = { ...json, cookie: await studioCookie(running.base) };
    assert.deepEqual(await (await fetch(`${running.base}/api/v1/preferences`, { headers })).json(), {});
    const put = (body: unknown) => fetch(`${running.base}/api/v1/preferences`, { method: "PUT", headers, body: JSON.stringify(body) });
    assert.deepEqual(await (await put({ language: "it", theme: "Night" })).json(), { language: "it", theme: "Night" });
    const refused = await put({ language: "Italian" });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "invalid_language" });
    assert.deepEqual(await (await put({})).json(), { language: "it", theme: "Night" }, "an empty body changes nothing");
    assert.deepEqual(await (await fetch(`${running.base}/api/v1/preferences`, { headers })).json(), { language: "it", theme: "Night" });
  } finally { await running.stop(); }
});
