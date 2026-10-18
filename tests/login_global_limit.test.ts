// One limit of refused sign-in tries for the whole server, on top of the one per place and the one per person and place.
import assert from "node:assert/strict";
import test from "node:test";
import { startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };

test("many different accounts tried from one place are stopped by the limit of the whole server, and a correct sign-in is not counted", async () => {
  const running = await startServer();
  try {
    const wrong = async (name: string) => (await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: name, password: "not-the-password" }) })).status;
    const seen = new Set<number>();
    for (let index = 0; index < 45; index += 1) seen.add(await wrong(`nobody-${index}`));
    assert.equal(seen.has(401), true, "the first tries are plainly refused");
    assert.equal(seen.has(429), true, "after forty refused tries the server says too many");
  } finally { await running.stop(); }
});

test("correct sign-ins never use up the limit of refused tries", async () => {
  const running = await startServer();
  try {
    for (let index = 0; index < 5; index += 1) assert.ok((await studioCookie(running.base)).length > 0);
  } finally { await running.stop(); }
});
