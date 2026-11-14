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

test("a session in use is renewed once half of its life has gone, and one nobody uses is not", () => {
  let now = 1_000_000;
  const store = new SessionStore({ cookieName: "s", cookiePath: "/", ttlMs: 60_000, secure: false }, () => now);
  const { response, calls } = fakeResponse();
  store.open(response, "user-1");
  const request = requestWith({ cookie: `s=${calls[0].value}` });
  now += 20_000;   // a third of its life: nothing to renew
  assert.equal(store.renew(request, fakeResponse().response), false);
  now += 20_000;   // past half of it (40 s of 60)
  const second = fakeResponse();
  assert.equal(store.renew(request, second.response), true);
  assert.equal(second.calls.length, 1, "the cookie is set again with its new life");
  now += 59_000;   // would have ended at 60 s after the opening: it is alive because it was renewed
  assert.equal(store.has(request), true);
  now += 2_000;    // and a full life after the renewal it does end
  assert.equal(store.has(request), false);
  assert.equal(store.renew(request, fakeResponse().response), false);
});

test("a session in use never lives past its absolute maximum, however often it is renewed", () => {
  let now = 1_000_000;
  const store = new SessionStore({ cookieName: "s", cookiePath: "/", ttlMs: 60_000, secure: false, maxAgeMs: 150_000 }, () => now);
  const { response, calls } = fakeResponse();
  store.open(response, "user-1");
  const request = requestWith({ cookie: `s=${calls[0].value}` });
  now += 40_000;
  assert.equal(store.renew(request, fakeResponse().response), true);   // ends at 100 s
  now += 40_000;
  assert.equal(store.renew(request, fakeResponse().response), true);   // would be 140 s, the cap is 150 s
  now += 30_000;                                                       // 110 s old
  assert.equal(store.renew(request, fakeResponse().response), true);   // gets the 40 s left, no more
  now += 39_000;
  assert.equal(store.has(request), true);
  assert.equal(store.renew(request, fakeResponse().response), false, "nothing left to give");
  now += 2_000;                                                        // 151 s old
  assert.equal(store.has(request), false, "the cap ends it though it was in use");
});

test("with rotation on, a renewal gives a new id and the old one still works for a short grace only", () => {
  let now = 1_000_000;
  let rotate = true;
  const store = new SessionStore({ cookieName: "s", cookiePath: "/", ttlMs: 60_000, secure: false, rotateIds: () => rotate }, () => now);
  const { response, calls } = fakeResponse();
  store.open(response, "user-1");
  const oldRequest = requestWith({ cookie: `s=${calls[0].value}` });
  now += 40_000;
  const renewed = fakeResponse();
  assert.equal(store.renew(oldRequest, renewed.response), true);
  const fresh = requestWith({ cookie: `s=${renewed.calls[0].value}` });
  assert.notEqual(renewed.calls[0].value, calls[0].value, "a different id");
  assert.equal(store.size, 1, "one session, not two");
  assert.equal(store.has(fresh), true);
  assert.equal(store.userId(oldRequest), "user-1", "a request already in flight with the old id is not signed out");
  now += 31_000;
  assert.equal(store.has(oldRequest), false, "after the grace the old id is dead");
  assert.equal(store.has(fresh), true);
  rotate = false;
  now += 25_000;
  const plain = fakeResponse();
  assert.equal(store.renew(fresh, plain.response), true);
  assert.equal(plain.calls[0].value, renewed.calls[0].value, "with the switch off the id stays");
});
