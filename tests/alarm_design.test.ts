import assert from "node:assert/strict";
import test from "node:test";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

test("the alarm design is kept, versioned and refused when it is stale, like the other drawings", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const url = `${running.base}/api/v1/alarm/design`;
    const get = async () => (await (await fetch(url, { headers: { cookie } })).json()) as { revision: number; alarm_design: unknown };
    const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    assert.deepEqual(await get(), { revision: 0, updated_at: null, updated_by: null, alarm_design: null });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await put({ revision: 0, alarm_design: { elements: [{ id: "central-1" }] } })).status, 200);
    assert.equal((await get()).revision, 1);
    const stale = await put({ revision: 0, alarm_design: { elements: [] } });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { current: { revision: number } }).current.revision, 1);
    assert.equal((await put({ revision: 1, alarm_design: "text" })).status, 400);
    assert.equal((await put({ revision: 1, alarm_design: { big: "x".repeat(787_500) } })).status, 400);
    // the operator token reads it too, and the versions are listed
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } })).status, 200);
    assert.equal((await fetch(`${url}/versions`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${url}/versions/nope`, { headers: { cookie } })).status, 404);
  } finally { await running.stop(); }
});
