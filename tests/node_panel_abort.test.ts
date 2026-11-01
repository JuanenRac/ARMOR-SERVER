// A browser that leaves while the panel of a node is still answering must not leave the server holding the connection to the node open.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };

test("when the browser leaves in the middle of an answer, the connection to the node is closed too", async () => {
  let closed = false;
  let drip: NodeJS.Timeout | undefined;
  const node = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("first");
    drip = setInterval(() => response.write("more"), 50);
    response.on("close", () => { closed = true; clearInterval(drip); });
  });
  await new Promise<void>(resolve => node.listen(0, "127.0.0.1", resolve));
  const port = (node.address() as { port: number }).port;
  process.env.ARMOR_ADMIN_NODE_PORT = String(port);
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await fetch(`${running.base}/api/v1/admin/node-panels/radar-salon`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ address: "127.0.0.1", scheme: "http", port, label: "Salon" }) });
    const controller = new AbortController();
    const reply = await fetch(`${running.base}/api/v1/nodes/radar-salon/panel/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
    const reader = reply.body!.getReader();
    await reader.read();
    controller.abort();
    const until = Date.now() + 3_000;
    while (!closed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(closed, "the connection to the node stayed open after the browser left");
  } finally { clearInterval(drip); node.closeAllConnections(); node.close(); await running.stop(); }
});
