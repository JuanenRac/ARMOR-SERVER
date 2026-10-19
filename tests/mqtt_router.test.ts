import assert from "node:assert/strict";
import test from "node:test";
import { routeMessage, topicsOf, type RouteTable } from "../src/mqtt_router.js";
import { healthTopic, isNodeBirth, isNodeWill, parseNodeHealth } from "../src/node_health.js";

const buffer = (value: unknown) => Buffer.from(JSON.stringify(value));
const logOf = () => { const ok: string[] = []; return { ok: (topic: string) => { ok.push(topic); }, rejected: () => undefined, seen: ok } as never as { ok: (topic: string) => void; rejected: () => void; seen: string[] }; };

test("each route takes only its own topics and the first match wins", () => {
  const got: string[] = [];
  const routes: RouteTable = [
    { subscribe: ["a/+/state"], named: (t: string) => (/^a\/([a-z]+)\/state$/.exec(t)?.[1]), parse: (b: unknown) => b as { node_id: string }, matches: (m: { node_id: string }, n: string) => m.node_id === n, apply: (m: { node_id: string }) => got.push(`a:${m.node_id}`), fallback: "bad a" },
    { subscribe: ["b/+/state"], named: (t: string) => (/^b\/([a-z]+)\/state$/.exec(t)?.[1]), parse: (b: unknown) => b as { node_id: string }, matches: (m: { node_id: string }, n: string) => m.node_id === n, apply: (m: { node_id: string }) => got.push(`b:${m.node_id}`), fallback: "bad b" },
  ];
  const rejected: string[] = [];
  const log = logOf();
  assert.deepEqual(topicsOf(routes), ["a/+/state", "b/+/state"]);
  assert.equal(routeMessage(routes, log as never, (topic) => { rejected.push(topic); }, "b/x/state", buffer({ node_id: "x" })), true);
  assert.equal(routeMessage(routes, log as never, (topic) => { rejected.push(topic); }, "c/x/state", buffer({ node_id: "x" })), false);
  assert.deepEqual(got, ["b:x"]);
  assert.deepEqual(log.seen, ["b/x/state"]);
});

test("a body that names another node than the topic is refused, not applied", () => {
  const got: string[] = [];
  const rejected: Array<[string, unknown]> = [];
  const routes: RouteTable = [{ subscribe: ["a/+/state"], named: (t: string) => (/^a\/([a-z]+)\/state$/.exec(t)?.[1]), parse: (b: unknown) => b as { node_id: string }, matches: (m: { node_id: string }, n: string) => m.node_id === n, apply: (m: { node_id: string }) => got.push(m.node_id), fallback: "bad" }];
  routeMessage(routes, logOf() as never, (topic, _raw, error) => { rejected.push([topic, (error as Error).message]); }, "a/north/state", buffer({ node_id: "south" }));
  assert.deepEqual(got, []);
  assert.deepEqual(rejected, [["a/north/state", "node_id does not match the topic"]]);
});

test("a body that is not JSON is refused with the route's own words", () => {
  const rejected: string[] = [];
  const routes: RouteTable = [{ subscribe: ["a/+/state"], named: (t: string) => (t === "a/n/state" ? "n" : undefined), parse: (b: unknown) => b, matches: () => true, apply: () => undefined, fallback: "bad" }];
  routeMessage(routes, logOf() as never, (topic, _raw, error, fallback) => { rejected.push(`${topic}|${(error as Error).name}|${fallback}`); }, "a/n/state", Buffer.from("{nope"));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!, /^a\/n\/state\|SyntaxError\|bad$/);
});

test("the last will of a node: only {node_id, online:false} for the node of the topic", () => {
  assert.equal(healthTopic("armor/health/radar-1"), "radar-1");
  assert.equal(isNodeWill({ node_id: "radar-1", online: false }, "radar-1"), true);
  assert.equal(isNodeWill({ node_id: "radar-2", online: false }, "radar-1"), false, "a will that names another node");
  assert.equal(isNodeWill({ node_id: "radar-1", online: true }, "radar-1"), false);
  assert.equal(isNodeBirth({ node_id: "radar-1", online: true }, "radar-1"), true);
  assert.equal(isNodeBirth({ node_id: "radar-2", online: true }, "radar-1"), false, "a birth that names another node");
  assert.equal(isNodeBirth({ node_id: "radar-1", online: false }, "radar-1"), false);
  assert.equal(isNodeBirth({ node_id: "radar-1", online: true, uptime_s: 5 }, "radar-1"), false, "a health report is never a birth");
  assert.equal(isNodeBirth(null, "radar-1") || isNodeBirth([], "radar-1"), false);
  assert.equal(isNodeWill({ node_id: "radar-1", online: false, uptime_s: 5 }, "radar-1"), false, "a health report is never a will");
  assert.equal(isNodeWill(null, "radar-1"), false);
  assert.equal(isNodeWill([], "radar-1"), false);
  assert.throws(() => parseNodeHealth({ node_id: "radar-1", online: false }), "the will is not a valid health report, so it must be intercepted before the parser");
});

test("the will reaches the node's life record through the health route and does not count as a report", () => {
  const gone: string[] = [];
  const routes: RouteTable = [{ subscribe: ["armor/health/+"], named: healthTopic, parse: parseNodeHealth, fallback: "bad",
    intercept: (body: unknown, named: string) => { if (!isNodeWill(body, named)) return false; gone.push(named); return true; },
    matches: () => true, apply: () => { throw new Error("a will must not be applied as a report"); } }];
  const log = logOf();
  assert.equal(routeMessage(routes, log as never, () => { throw new Error("refused"); }, "armor/health/radar-1", buffer({ node_id: "radar-1", online: false })), true);
  assert.deepEqual(gone, ["radar-1"]);
  assert.deepEqual(log.seen, [], "a will is not an ingested report");
});
