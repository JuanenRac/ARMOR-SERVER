import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LoginCountries, MAX_COUNTRIES_PER_PERSON, MAX_PEOPLE } from "../src/login_places.js";

function folder(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "armor-places-")); }

test("the first country is only learned, a second one is new once and a third sign-in from either is known", () => {
  const dir = folder();
  try {
    const places = new LoginCountries(path.join(dir, "places.json"));
    assert.equal(places.note("ana", "ES"), "first");
    assert.equal(places.note("ana", "ES"), "known");
    assert.equal(places.note("ana", "PT"), "new");
    assert.equal(places.note("ana", "PT"), "known", "a new country is told one time and learned");
    assert.equal(places.note("ana", "ES"), "known");
    assert.equal(places.note("luis", "PT"), "first", "what one person has seen says nothing about another");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only the newest countries of a person are kept, and the oldest one is told as new again", () => {
  const dir = folder();
  try {
    const places = new LoginCountries(path.join(dir, "places.json"));
    const codes: string[] = [];
    for (let index = 0; index < MAX_COUNTRIES_PER_PERSON + 3; index += 1) codes.push(String.fromCharCode(65 + Math.floor(index / 26)) + String.fromCharCode(65 + (index % 26)));
    for (const code of codes) places.note("ana", code);
    const kept = places.countriesOf("ana");
    assert.equal(kept.length, MAX_COUNTRIES_PER_PERSON);
    assert.deepEqual(kept, codes.slice(-MAX_COUNTRIES_PER_PERSON));
    assert.equal(places.note("ana", codes[0]!), "new", "a country that fell off the list is a stranger again");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the list of people is bounded: the oldest person is dropped to make room for a new one", () => {
  const dir = folder();
  try {
    const places = new LoginCountries(path.join(dir, "places.json"));
    for (let index = 0; index < MAX_PEOPLE; index += 1) places.note(`person-${index}`, "ES");
    assert.equal(places.note("newcomer", "ES"), "first");
    assert.deepEqual(places.countriesOf("person-0"), [], "the person kept longest ago was dropped");
    assert.deepEqual(places.countriesOf("person-1"), ["ES"]);
    assert.deepEqual(places.countriesOf("newcomer"), ["ES"]);
    // a person already known does not push anybody out
    places.note("person-1", "PT");
    assert.deepEqual(places.countriesOf("person-2"), ["ES"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a long name is cut to 80 characters in the same way when it is noted and when it is asked", () => {
  const dir = folder();
  try {
    const places = new LoginCountries(path.join(dir, "places.json"));
    const long = "x".repeat(200);
    places.note(long, "ES");
    assert.deepEqual(places.countriesOf("x".repeat(80)), ["ES"]);
    assert.equal(places.note("x".repeat(80) + "different tail", "ES"), "known");
    places.forget(long);
    assert.deepEqual(places.countriesOf(long), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a damaged or hostile file is ignored or cleaned, never trusted", () => {
  const dir = folder();
  try {
    const file = path.join(dir, "places.json");
    fs.writeFileSync(file, "{not json");
    assert.equal(new LoginCountries(file).note("ana", "ES"), "first", "a file that does not parse starts empty");
    fs.writeFileSync(file, JSON.stringify(["ES", "PT"]));
    assert.equal(new LoginCountries(file).note("ana", "ES"), "first", "an array is not a table of people");
    fs.writeFileSync(file, JSON.stringify({ ana: ["ES", "pt", "PRT", 7, null, "E1", "FR"], bob: "ES", carl: { 0: "ES" } }));
    const loaded = new LoginCountries(file);
    assert.deepEqual(loaded.countriesOf("ana"), ["ES", "FR"], "only two upper-case letters count as a country");
    assert.deepEqual(loaded.countriesOf("bob"), []);
    assert.deepEqual(loaded.countriesOf("carl"), []);
    assert.equal(loaded.note("ana", "pt"), "new", "the country the caller passes is not checked here, the list is what is cleaned");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("what is learned survives a restart and the file is private to the owner", () => {
  const dir = folder();
  try {
    const file = path.join(dir, "deeper", "places.json");
    const places = new LoginCountries(file);
    places.note("ana", "ES");
    places.note("ana", "PT");
    assert.deepEqual(new LoginCountries(file).countriesOf("ana"), ["ES", "PT"]);
    assert.equal(fs.existsSync(`${file}.tmp`), false, "the temporary file does not stay behind");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a folder that cannot be written does not stop the sign-in: the countries stay in memory", () => {
  const dir = folder();
  try {
    const blocker = path.join(dir, "file-not-folder");
    fs.writeFileSync(blocker, "x");
    const places = new LoginCountries(path.join(blocker, "places.json"));
    assert.equal(places.note("ana", "ES"), "first");
    assert.equal(places.note("ana", "ES"), "known");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
