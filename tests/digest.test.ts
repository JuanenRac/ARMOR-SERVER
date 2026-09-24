import assert from "node:assert/strict";
import test from "node:test";
import { answerChallenge, digestAuthorization, parseDigestChallenge } from "../src/cameras/digest.js";

// The worked example from RFC 2617 section 3.5.
const RFC_HEADER = 'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';

test("computes the RFC 2617 example response", () => {
  const challenge = parseDigestChallenge(RFC_HEADER)!;
  assert.equal(challenge.qop, "auth");
  const header = digestAuthorization(challenge, { username: "Mufasa", password: "Circle Of Life", method: "GET", uri: "/dir/index.html", nonceCount: 1, cnonce: "0a4f113b" });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test("a challenge without qop uses the legacy response formula", () => {
  const challenge = parseDigestChallenge('Digest realm="cam", nonce="abc"')!;
  assert.equal(challenge.qop, undefined);
  const header = digestAuthorization(challenge, { username: "u", password: "p", method: "DESCRIBE", uri: "rtsp://h/x" });
  assert.doesNotMatch(header, /qop=|cnonce=/);
  assert.match(header, /response="[0-9a-f]{32}"/);
});

test("SHA-256 challenges are answered with SHA-256", () => {
  const challenge = parseDigestChallenge('Digest realm="cam", nonce="abc", algorithm=SHA-256, qop="auth"')!;
  const header = digestAuthorization(challenge, { username: "u", password: "p", method: "GET", uri: "/", cnonce: "cn" });
  assert.match(header, /response="[0-9a-f]{64}"/);
  assert.match(header, /algorithm=SHA-256/);
});

test("unusable challenges are refused instead of guessed", () => {
  assert.equal(parseDigestChallenge(undefined), null);
  assert.equal(parseDigestChallenge("Bearer x"), null);
  assert.equal(parseDigestChallenge('Digest realm="r"'), null);
  assert.equal(parseDigestChallenge('Digest realm="r", nonce="n", algorithm=SHA-512'), null);
  assert.equal(parseDigestChallenge('Digest realm="r", nonce="n", qop="auth-int"'), null);
});

test("Basic and Digest challenges are both answered; nothing else is", () => {
  const credentials = { username: "u", password: "p" };
  assert.equal(answerChallenge('Basic realm="x"', credentials, "GET", "/"), `Basic ${Buffer.from("u:p").toString("base64")}`);
  assert.match(answerChallenge('Digest realm="r", nonce="n"', credentials, "GET", "/")!, /^Digest /);
  assert.equal(answerChallenge("Negotiate", credentials, "GET", "/"), null);
  assert.equal(answerChallenge(undefined, credentials, "GET", "/"), null);
});

test("quotes in a username cannot break out of the header", () => {
  const challenge = parseDigestChallenge('Digest realm="r", nonce="n"')!;
  const header = digestAuthorization(challenge, { username: 'a", response="evil', password: "p", method: "GET", uri: "/" });
  assert.equal((header.match(/response="/g) ?? []).length, 1);
  assert.match(header, /username="a, response=evil"/);
});
