import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { hasBearer, requestCookies, secureEquals, SessionStore } from "../src/http/auth.js";

const requestWith = (headers: Record<string, string>) => ({ header: (name: string) => headers[name.toLowerCase()] });
const fakeResponse = () => {
  const calls: { name: string; value: string }[] = [];
  return { response: { cookie: (name: string, value: string) => { calls.push({ name, value }); }, clearCookie: () => undefined } as unknown as Response, calls };
};

test("secureEquals compares exactly, whatever the lengths", () => {
  assert.equal(secureEquals("abc", "abc"), true);
  assert.equal(secureEquals("abc", "abd"), false);
  assert.equal(secureEquals("abc", "abcd"), false);
  assert.equal(secureEquals("abcd", "abc"), false);
  assert.equal(secureEquals("", ""), true);
});

test("a bearer token must match exactly", () => {
  assert.equal(hasBearer(requestWith({ authorization: "Bearer secret-token" }), "secret-token"), true);
  assert.equal(hasBearer(requestWith({ authorization: "Bearer secret-token2" }), "secret-token"), false);
  assert.equal(hasBearer(requestWith({ authorization: "Basic secret-token" }), "secret-token"), false);
  assert.equal(hasBearer(requestWith({}), "secret-token"), false);
});

test("cookies are parsed, decoded and never throw on garbage", () => {
  assert.deepEqual(requestCookies(requestWith({ cookie: "a=1; b=hello%20world; =x; broken" })), { a: "1", b: "hello world" });
  assert.deepEqual(requestCookies(requestWith({ cookie: "a=%E0%A4%A" })), {});
});

test("a session works until it expires and then disappears", () => {
  let now = 1_000;
  const store = new SessionStore({ cookieName: "s", cookiePath: "/", ttlMs: 60_000, secure: false }, () => now);
  const { response, calls } = fakeResponse();
  store.open(response);
  const cookie = requestWith({ cookie: `s=${calls[0].value}` });
  assert.equal(store.has(cookie), true);
  now += 60_001;
  assert.equal(store.has(cookie), false);
  assert.equal(store.size, 0);
  assert.equal(store.has(requestWith({})), false);
});

test("the session table is capped so a login flood cannot grow memory", () => {
  const store = new SessionStore({ cookieName: "s", cookiePath: "/", ttlMs: 60_000, secure: false, capacity: 5 });
  const { response } = fakeResponse();
  for (let index = 0; index < 50; index += 1) store.open(response);
  assert.ok(store.size <= 5);
});

test("closing a session invalidates its cookie", () => {
  const store = new SessionStore({ cookieName: "s", cookiePath: "/", ttlMs: 60_000, secure: false });
  const { response, calls } = fakeResponse();
  store.open(response);
  const cookie = requestWith({ cookie: `s=${calls[0].value}` });
  store.close(cookie, response);
  assert.equal(store.has(cookie), false);
});
