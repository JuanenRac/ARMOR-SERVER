import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GeoIpDatabase, GeoIpInvalid, addressBytes } from "../src/geoip.js";
import { LoginCountries } from "../src/login_places.js";
import { alertText } from "../src/alert_text.js";
import { buildMmdb } from "./mmdb_builder.js";
import { SECRETS, startServer } from "./helpers.js";

const PREFIXES = [
  { cidr: "203.0.113.0/24", country: "ES" },
  { cidr: "198.51.100.0/24", country: "FR" },
  { cidr: "127.0.0.0/8", country: "PT" },
  { cidr: "2001:db8::/32", country: "DE" },
];

test("addresses are read as bytes, an IPv4 address written as IPv6 is the IPv4 one, and what is not an address is nothing", () => {
  assert.deepEqual([...addressBytes("203.0.113.9")!], [203, 0, 113, 9]);
  assert.deepEqual([...addressBytes("::ffff:203.0.113.9")!], [203, 0, 113, 9]);
  assert.deepEqual([...addressBytes("::ffff:cb00:7109")!], [203, 0, 113, 9]);
  assert.equal(addressBytes("2001:db8::1")!.length, 16);
  assert.deepEqual([...addressBytes("::1")!].slice(-2), [0, 1]);
  for (const bad of ["", "nope", "1.2.3", "1.2.3.4.5", "300.1.1.1", "1::2::3", "[::1"]) assert.equal(addressBytes(bad), undefined, bad);
});

for (const recordBits of [24, 28, 32] as const) {
  test(`the country of an address comes from the file (records of ${recordBits} bits, IPv6 tree)`, () => {
    const database = new GeoIpDatabase(buildMmdb(PREFIXES, { recordBits }));
    assert.equal(database.country("203.0.113.77"), "ES");
    assert.equal(database.country("198.51.100.1"), "FR");
    assert.equal(database.country("::ffff:198.51.100.1"), "FR");
    assert.equal(database.country("2001:db8:1::5"), "DE");
    assert.equal(database.country("2001:db9::5"), undefined);   // not in the file
    assert.equal(database.country("8.8.8.8"), undefined);
    assert.equal(database.country("not an address"), undefined);
  });
}

test("a tree of IPv4 answers IPv4 and knows nothing of IPv6", () => {
  const database = new GeoIpDatabase(buildMmdb(PREFIXES.slice(0, 3), { ipVersion: 4 }));
  assert.equal(database.country("203.0.113.1"), "ES");
  assert.equal(database.country("127.0.0.1"), "PT");
  assert.equal(database.country("2001:db8::1"), undefined);
});

test("a file that is not a country database, or is damaged, is refused and never read outside itself", () => {
  assert.throws(() => new GeoIpDatabase(Buffer.from("hello")), GeoIpInvalid);
  const good = buildMmdb(PREFIXES);
  const marker = good.lastIndexOf(Buffer.from("MaxMind.com"));
  assert.throws(() => new GeoIpDatabase(good.subarray(0, marker - 2)), GeoIpInvalid);   // metadata cut off
  // the data section overwritten with noise and the metadata kept: every lookup answers nothing or something, and never reads past the end
  const damaged = Buffer.from(good);
  const database = new GeoIpDatabase(damaged);
  damaged.fill(0xFF, damaged.length - 120, marker - 3);
  for (const address of ["203.0.113.9", "198.51.100.9", "2001:db8::1"]) assert.doesNotThrow(() => database.country(address));
});

test("a file on disk is opened, and a missing one is an error to report, not a crash", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-geo-")), "country.mmdb");
  fs.writeFileSync(file, buildMmdb(PREFIXES));
  assert.equal(GeoIpDatabase.open(file).country("203.0.113.9"), "ES");
  assert.throws(() => GeoIpDatabase.open(file + ".missing"));
});

test("the countries of a person are learned, the first is only learned, a different one is new once, and they survive a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-places-")), "login-countries.json");
  const places = new LoginCountries(file);
  assert.equal(places.note("ana", "ES"), "first");
  assert.equal(places.note("ana", "ES"), "known");
  assert.equal(places.note("ana", "FR"), "new");
  assert.equal(places.note("ana", "FR"), "known");   // told once
  assert.equal(places.note("luis", "FR"), "first");   // another person starts again
  const again = new LoginCountries(file);
  assert.deepEqual(again.countriesOf("ana"), ["ES", "FR"]);
  assert.equal(again.note("ana", "PT"), "new");
  again.forget("ana");
  assert.deepEqual(new LoginCountries(file).countriesOf("ana"), []);
});

test("the sentence of a sign-in from a new country is in the eight languages and names the country", () => {
  const base = { service: "armor-server", event: "login.remote", at: "1970-01-01T00:00:00.000Z", mode: "armed", login_user: "ana", login_from: "203.0.113.9", login_country: "ES" };
  const usual = alertText(base as never, "en");
  for (const language of ["en", "es", "de", "fr", "it", "ja", "zh", "pt"] as const) {
    const text = alertText({ ...base, login_country_new: true } as never, language);
    assert.ok(text.includes("ES") && text.includes("203.0.113.9") && text.includes("ana"), language);
    assert.ok(!/\{\d\}/.test(text), `${language} has a hole left`);
  }
  assert.ok(!usual.includes("ES"));
});

const json = { "Content-Type": "application/json" };

test("with a country database, a sign-in from a country never seen is told even from an address seen before, once, and the option turns it off", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-geo-")), "country.mmdb");
  fs.writeFileSync(file, buildMmdb(PREFIXES));
  const running = await startServer({ ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_GEOIP_DB: file });   // the test client (127.0.0.1) is then "outside", and the file says it is in PT
  const sent: Array<{ event: string; login_country?: string; login_country_new?: true }> = [];
  const original = running.app.context.notifier.send.bind(running.app.context.notifier);
  running.app.context.notifier.send = message => { sent.push(message as never); original(message); };
  const credentials = { username: SECRETS.ARMOR_STUDIO_USERNAME, password: SECRETS.ARMOR_STUDIO_PASSWORD };
  const signIn = async () => (await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).status;
  const logins = () => sent.filter(message => message.event === "login.remote");
  try {
    assert.ok(running.app.context.geoip, "the database was opened");
    assert.equal(await signIn(), 201);
    assert.equal(await signIn(), 201);
    assert.equal(logins().length, 1);
    assert.equal(logins()[0]!.login_country, "PT");
    assert.equal(logins()[0]!.login_country_new, undefined, "the first country of a person is only learned");
    // the same address now belongs to another country
    (running.app.context as { geoip: unknown }).geoip = { country: () => "FR" };
    assert.equal(await signIn(), 201);
    assert.equal(logins().length, 2);
    assert.deepEqual([logins()[1]!.login_country, logins()[1]!.login_country_new], ["FR", true]);
    assert.equal(await signIn(), 201);
    assert.equal(logins().length, 2, "told once");
    // with the option off, no country is looked up or told
    running.app.context.securitySettings.update({ "login.country_alert": false });
    (running.app.context as { geoip: unknown }).geoip = { country: () => "DE" };
    assert.equal(await signIn(), 201);
    assert.equal(logins().length, 2);
  } finally { await running.stop(); }
});

test("a country database that cannot be read only turns the lookup off", async () => {
  const running = await startServer({ ARMOR_GEOIP_DB: path.join(os.tmpdir(), "armor-geo-not-there.mmdb") });
  try { assert.equal(running.app.context.geoip, null); } finally { await running.stop(); }
});
