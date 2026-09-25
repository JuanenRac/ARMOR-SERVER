import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { EventLog, type ArmorEventBody } from "../src/events.js";
import { SECRETS, startServer, tempDir } from "./helpers.js";

/** A log whose clock is set by the test, so ages are exact. */
function logAt(file: string, clock: { now: number }, capacity = 5000) {
  return new EventLog({ file, capacity, now: () => new Date(clock.now) });
}
const day = 86_400_000;
const alert = (node: string, to: "review" | "high" | "normal"): ArmorEventBody => ({ type: "alert", node_id: node, from: "normal", to, targets: 2 });

function seeded() {
  const clock = { now: Date.parse("2026-03-01T12:00:00Z") };
  const file = path.join(tempDir(), "events.log");
  const log = logAt(file, clock);
  log.append(alert("north-1", "high"));                                             // 1: 10 days ago
  clock.now += 5 * day;
  log.append({ type: "node", node_id: "north-1", from: "online", to: "offline" });  // 2: 5 days ago
  log.append({ type: "camera", camera_id: "cam-01", from: "online", to: "offline" }); // 3
  clock.now += 4.5 * day;
  log.append(alert("south-2", "review"));                                           // 4: 12 hours ago
  log.append({ type: "mode", mode: "armed" });                                      // 5
  log.append(alert("north-1", "high"));                                             // 6
  clock.now += 0.5 * day;
  return { log, file, clock };
}

test("history can be searched, filtered by level and time, and read oldest first", () => {
  const { log, clock } = seeded();
  assert.deepEqual(log.list({ q: "NORTH" }).map(event => event.id), [6, 2, 1]);
  assert.deepEqual(log.list({ q: "cam" }).map(event => event.id), [3]);
  assert.deepEqual(log.list({ level: "high" }).map(event => event.id), [6, 1]);
  assert.deepEqual(log.list({ since: clock.now - 2 * day }).map(event => event.id), [6, 5, 4]);
  assert.deepEqual(log.list({ until: clock.now - 7 * day }).map(event => event.id), [1]);
  assert.deepEqual(log.list({ order: "asc", limit: 3 }).map(event => event.id), [1, 2, 3]);
  assert.deepEqual(log.list({ order: "asc", before: 3, limit: 3 }).map(event => event.id), [4, 5, 6], "paging forward continues after the last id");
  assert.deepEqual(log.list({ type: "alert", q: "south" }).map(event => event.id), [4]);
});

test("the summary counts what is held and what happened in the last day", () => {
  const { log, clock } = seeded();
  const summary = log.summary(clock.now);
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.by_type, { alert: 3, node: 1, camera: 1, mode: 1 });
  assert.deepEqual(summary.last_24h, { events: 3, high_alerts: 1, node_incidents: 0, camera_incidents: 0 });
  assert.equal(log.summary(clock.now - 4.6 * day).last_24h.camera_incidents, 1);
  assert.ok(summary.oldest_at && summary.newest_at && summary.oldest_at < summary.newest_at);
});

test("deleting history removes it for good, keeps numbering and survives a restart", () => {
  const { log, file, clock } = seeded();
  assert.deepEqual(log.delete({ before: clock.now - 7 * day }), { deleted: 1, remaining: 5 });
  assert.deepEqual(log.list({ limit: 10 }).map(event => event.id), [6, 5, 4, 3, 2]);
  assert.deepEqual(log.delete({ type: "alert" }), { deleted: 2, remaining: 3 });
  assert.deepEqual(log.list({ limit: 10 }).map(event => event.id), [5, 3, 2]);
  const restarted = logAt(file, clock);
  assert.deepEqual(restarted.list({ limit: 10 }).map(event => event.id), [5, 3, 2], "the removal is on disk, not only in memory");
  assert.equal(restarted.append(alert("north-1", "high")).id, 7, "event numbers are never reused");
  assert.deepEqual(log.delete(), { deleted: 4, remaining: 0 }, "the event appended after the restart is on disk too");
  assert.equal(log.list().length, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("deletion also reaches the rotated log files and events beyond the browsing window", () => {
  const clock = { now: Date.parse("2026-03-01T12:00:00Z") };
  const file = path.join(tempDir(), "events.log");
  fs.writeFileSync(`${file}.2`, JSON.stringify({ id: 1, at: new Date(clock.now - 30 * day).toISOString(), type: "mode", mode: "armed" }) + "\n");
  fs.writeFileSync(`${file}.1`, JSON.stringify({ id: 2, at: new Date(clock.now - 20 * day).toISOString(), type: "mode", mode: "disarmed" }) + "\n");
  fs.writeFileSync(file, JSON.stringify({ id: 3, at: new Date(clock.now - 1 * day).toISOString(), type: "mode", mode: "armed" }) + "\n");
  const log = logAt(file, clock, 2);   // it only browses two, but holds three on disk
  assert.equal(log.list().length, 2);
  assert.deepEqual(log.delete({ before: clock.now - 10 * day }), { deleted: 2, remaining: 1 });
  assert.equal(fs.existsSync(`${file}.1`) || fs.existsSync(`${file}.2`), false);
  assert.deepEqual(logAt(file, clock).list().map(event => event.id), [3]);
});

test("history routes: filters are validated, deletion needs a confirmation and is audited", async () => {
  const running = await startServer();
  try {
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    const { events } = running.app.context;
    events.append(alert("north-1", "high"));
    events.append({ type: "camera", camera_id: "cam-01", from: "online", to: "offline" });
    const get = (query: string) => fetch(`${running.base}/api/v1/history${query}`, { headers: operator });

    assert.equal((await fetch(`${running.base}/api/v1/history/summary`)).status, 401);
    const summary = await (await fetch(`${running.base}/api/v1/history/summary`, { headers: operator })).json() as { total: number; last_24h: { high_alerts: number } };
    assert.equal(summary.total, 2);
    assert.equal(summary.last_24h.high_alerts, 1);

    assert.equal((await get("?since=yesterday")).status, 400);
    assert.equal((await get("?level=urgent")).status, 400);
    assert.equal(((await (await get("?q=cam")).json()) as { events: unknown[] }).events.length, 1);
    assert.equal(((await (await get("?level=high&order=asc")).json()) as { events: unknown[] }).events.length, 1);

    const remove = (query: string, headers: Record<string, string> = operator) => fetch(`${running.base}/api/v1/history${query}`, { method: "DELETE", headers });
    assert.equal((await remove("?scope=all", {})).status, 401);
    assert.equal((await remove("?scope=all")).status, 400, "no confirmation");
    assert.equal((await remove("?scope=some&confirm=delete")).status, 400);
    assert.equal((await remove("?scope=older-than&days=0&confirm=delete")).status, 400);
    assert.equal((await remove("?scope=all&type=bogus&confirm=delete")).status, 400);
    assert.equal(events.summary().total, 2, "nothing was removed by a refused request");

    assert.equal((await remove("?scope=older-than&days=30&confirm=delete").then(response => response.json()) as { deleted: number }).deleted, 0);
    assert.deepEqual(await (await remove("?scope=all&type=camera&confirm=delete")).json(), { deleted: 1, remaining: 1 });
    assert.deepEqual(await (await remove("?scope=all&confirm=delete")).json(), { deleted: 1, remaining: 0 });
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /history\.delete/);
    assert.match(audit, /2 removed|1 removed/);
  } finally { await running.stop(); }
});
