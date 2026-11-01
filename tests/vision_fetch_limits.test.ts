/**
 * The real call to the live vision service (fetchVisionService), against a stand-in service on the loopback address: a service that drips its answer, one that closes in the middle of it
 * and one that answers more than the limit must each end in `null` within the time given, and a good answer must come back whole. The time given is for the whole answer, not for each pause.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fetchVisionService } from "../src/reports.js";

async function service(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/heatmap?format=json&scale=16`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("a good answer comes back whole, with its status and type", async () => {
  const stand = await service((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}'); });
  try {
    const answer = await fetchVisionService(stand.url, 2_000, 1024);
    assert.ok(answer);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.toString("utf8"), '{"ok":true}');
  } finally { await stand.close(); }
});

test("an answer that is dripped slowly is cut at the time given, not at the time of each pause", async () => {
  let timer: NodeJS.Timeout | undefined;
  const stand = await service((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    timer = setInterval(() => response.write("x"), 100);
    response.on("close", () => clearInterval(timer));
  });
  try {
    const started = Date.now();
    const answer = await fetchVisionService(stand.url, 600, 1024 * 1024);
    assert.equal(answer, null);
    assert.ok(Date.now() - started < 1500, `the call took ${Date.now() - started} ms for a limit of 600`);
  } finally { clearInterval(timer); await stand.close(); }
});

test("a service that closes in the middle of its answer gives null, not a partial answer", async () => {
  const stand = await service((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
    response.write("{\"half\":");
    setTimeout(() => request.socket.destroy(), 30);
  });
  try {
    const started = Date.now();
    const answer = await fetchVisionService(stand.url, 3_000, 1024 * 1024);
    assert.equal(answer, null);
    assert.ok(Date.now() - started < 2_000, "it waited for the whole time limit instead of seeing the connection close");
  } finally { await stand.close(); }
});

test("an answer over the size limit gives null", async () => {
  const stand = await service((_request, response) => { response.writeHead(200, { "Content-Type": "image/png" }); response.end(Buffer.alloc(5000)); });
  try { assert.equal(await fetchVisionService(stand.url, 2_000, 1000), null); } finally { await stand.close(); }
});

test("the bearer token is sent to the service, and nothing else of this server", async () => {
  let seen: http.IncomingHttpHeaders = {};
  const stand = await service((request, response) => { seen = request.headers; response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); });
  try {
    await fetchVisionService(stand.url, 2_000, 1024, "secret-token");
    assert.equal(seen.authorization, "Bearer secret-token");
    assert.equal(seen.cookie, undefined);
  } finally { await stand.close(); }
});
