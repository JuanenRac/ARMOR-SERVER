import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditBetween, buildIncident, parseWindow, verifyIncident } from "../src/incident_export.js";
import { startServer, studioCookie } from "./helpers.js";

const T0 = Date.parse("2030-01-01T10:00:00Z"), T1 = Date.parse("2030-01-01T12:00:00Z");

test("a window is two times, in order, no longer than a week", () => {
  assert.deepEqual(parseWindow("2030-01-01T10:00:00Z", "2030-01-01T12:00:00Z"), { fromMs: T0, toMs: T1 });
  assert.equal(parseWindow("2030-01-01T12:00:00Z", "2030-01-01T10:00:00Z"), undefined);
  assert.equal(parseWindow("2030-01-01T00:00:00Z", "2030-01-09T00:00:00Z"), undefined);
  assert.equal(parseWindow("nonsense", "2030-01-01T12:00:00Z"), undefined);
  assert.equal(parseWindow(undefined, undefined), undefined);
});

test("the audit lines of the window come from the current and the rotated files, oldest first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-incident-"));
  try {
    const line = (at: string, action: string) => JSON.stringify({ at, action, outcome: "allowed" });
    fs.writeFileSync(path.join(dir, "audit.log.1"), [line("2030-01-01T09:00:00Z", "a.before"), line("2030-01-01T10:30:00Z", "b.inside")].join("\n"));
    fs.writeFileSync(path.join(dir, "audit.log"), [line("2030-01-01T11:00:00Z", "c.inside"), "not json", line("2030-01-01T13:00:00Z", "d.after")].join("\n"));
    const trail = auditBetween(dir, T0, T1);
    assert.deepEqual(trail.lines.map(item => item.action), ["b.inside", "c.inside"]);
    assert.equal(trail.from, "2030-01-01T09:00:00Z");
    assert.equal(auditBetween(dir, T0, T1, 1).truncated, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the document verifies with the server's key and breaks when anything in it is changed", () => {
  const trail = { lines: [{ at: "2030-01-01T10:30:00Z", action: "x", outcome: "allowed" }], from: "2030-01-01T09:00:00Z", truncated: false };
  const incident = buildIncident("secret-1", { fromMs: T0, toMs: T1, events: [{ id: 1, type: "alert" }], eventsTruncated: false, audit: trail, files: [{ camera: "cam-01", kind: "snapshot", name: "a.jpg", bytes: 10, created_at: "2030-01-01T11:00:00Z", sha256: "a".repeat(64), protected: false }], filesTruncated: false });
  assert.equal(incident.audit_complete, true);
  assert.equal(verifyIncident(["other", "secret-1"], JSON.parse(JSON.stringify(incident))), true);
  assert.equal(verifyIncident(["other"], incident), false);
  const tamper = (change: (copy: any) => void) => { const copy = JSON.parse(JSON.stringify(incident)); change(copy); return verifyIncident(["secret-1"], copy); };
  assert.equal(tamper(copy => { copy.events.pop(); }), false);
  assert.equal(tamper(copy => { copy.files[0].sha256 = "b".repeat(64); }), false);
  assert.equal(tamper(copy => { copy.audit[0].action = "y"; }), false);
  assert.equal(tamper(copy => { copy.window.to = "2031-01-01T00:00:00.000Z"; }), false);
  assert.equal(verifyIncident(["secret-1"], null), false);
});

test("only an administrator gets the incident, a bad window is refused, and the document verifies through the server", async () => {
  const running = await startServer();
  try {
    const window = `from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`;
    assert.equal((await fetch(`${running.base}/api/v1/admin/incident?${window}`)).status, 401);
    const cookie = await studioCookie(running.base);
    assert.equal((await fetch(`${running.base}/api/v1/admin/incident?from=x&to=y`, { headers: { cookie } })).status, 400);
    const answer = await fetch(`${running.base}/api/v1/admin/incident?${window}`, { headers: { cookie } });
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get("content-disposition") ?? "", /armor-incident\.json/);
    const incident = await answer.json() as Record<string, unknown>;
    assert.ok(Array.isArray(incident.events) && Array.isArray(incident.audit) && Array.isArray(incident.files));
    const headers = { "Content-Type": "application/json", cookie };
    const checked = await (await fetch(`${running.base}/api/v1/admin/incident/verify`, { method: "POST", headers, body: JSON.stringify(incident) })).json() as { genuine: boolean; files_match: boolean };
    assert.deepEqual([checked.genuine, checked.files_match], [true, true]);
    const forged = { ...incident, events: [{ id: 99, type: "alert" }] };
    assert.equal(((await (await fetch(`${running.base}/api/v1/admin/incident/verify`, { method: "POST", headers, body: JSON.stringify(forged) })).json()) as { genuine: boolean }).genuine, false);
  } finally { await running.stop(); }
});
