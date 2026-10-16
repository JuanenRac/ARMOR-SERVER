import assert from "node:assert/strict";
import test from "node:test";
import { buildProof, custodyOf, verifyProof, type ProofFile } from "../src/evidence_proof.js";

const file: ProofFile = { camera: "cam-01", kind: "recordings", name: "a.mp4", bytes: 1234, created_at: "2000-01-01T00:00:00.000Z", sha256: "a".repeat(64), protected: true };
const lines = [
  { at: "2000-01-01T00:01:00.000Z", action: "evidence.protect", outcome: "allowed", actor: "admin", target: "cam-01/recordings/a.mp4" },
  { at: "2000-01-01T00:02:00.000Z", action: "evidence.hash", outcome: "allowed", actor: "guard", target: "cam-01/recordings/a.mp4" },
  { at: "2000-01-01T00:03:00.000Z", action: "evidence.hash", outcome: "allowed", target: "cam-01/recordings/other.mp4" },
];

test("a proof lists the audit lines of its file and verifies with the server's key only", () => {
  const custody = custodyOf(lines, "cam-01/recordings/a.mp4");
  assert.deepEqual(custody.map(line => `${line.action}:${line.actor}`), ["evidence.protect:admin", "evidence.hash:guard"]);
  const proof = buildProof("server-secret-1", file, custody, new Date("2000-02-01T00:00:00Z"));
  assert.equal(verifyProof("server-secret-1", proof), true);
  assert.equal(verifyProof("another-secret", proof), false);
  // it survives being copied through JSON, like a file handed over
  assert.equal(verifyProof("server-secret-1", JSON.parse(JSON.stringify(proof))), true);
});

test("changing anything in the document - the digest, the size, a custody line - breaks it", () => {
  const proof = buildProof("server-secret-1", file, custodyOf(lines, "cam-01/recordings/a.mp4"));
  const tamper = (change: (copy: any) => void) => { const copy = JSON.parse(JSON.stringify(proof)); change(copy); return verifyProof("server-secret-1", copy); };
  assert.equal(tamper(copy => { copy.file.sha256 = "b".repeat(64); }), false);
  assert.equal(tamper(copy => { copy.file.bytes = 1; }), false);
  assert.equal(tamper(copy => { copy.custody.pop(); }), false);
  assert.equal(tamper(copy => { copy.custody[0].actor = "someone-else"; }), false);
  assert.equal(tamper(copy => { copy.signature.value = "0".repeat(64); }), false);
  assert.equal(verifyProof("server-secret-1", null), false);
  assert.equal(verifyProof("server-secret-1", { version: 1 }), false);
});
