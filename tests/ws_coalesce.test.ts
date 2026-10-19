import assert from "node:assert/strict";
import test from "node:test";
import { createCoalescer } from "../src/ws_coalesce.js";

const fakeTimers = () => {
  const queue: Array<{ id: number; callback: () => void }> = [];
  let next = 1;
  return {
    set: (callback: () => void) => { const id = next++; queue.push({ id, callback }); return id; },
    clear: (handle: unknown) => { const index = queue.findIndex(item => item.id === handle); if (index >= 0) queue.splice(index, 1); },
    run: () => { const item = queue.shift(); item?.callback(); },
    get waiting() { return queue.length; },
  };
};

test("the first change is sent at once and a burst after it becomes one message with the newest value", () => {
  const timers = fakeTimers(), sent: number[] = [];
  const c = createCoalescer<number>(value => sent.push(value), 100, timers);
  c.push(1);
  c.push(2); c.push(3); c.push(4);
  assert.deepEqual(sent, [1]);
  timers.run();
  assert.deepEqual(sent, [1, 4]);
});

test("a quiet moment ends the window and the next change is sent at once again", () => {
  const timers = fakeTimers(), sent: number[] = [];
  const c = createCoalescer<number>(value => sent.push(value), 100, timers);
  c.push(1);
  timers.run();            // the window passes with nothing pending
  assert.equal(timers.waiting, 0);
  c.push(2);
  assert.deepEqual(sent, [1, 2]);
});

test("flush sends the pending state, and close drops it and stops the timer", () => {
  const timers = fakeTimers(), sent: number[] = [];
  const c = createCoalescer<number>(value => sent.push(value), 100, timers);
  c.push(1); c.push(2);
  c.flush();
  assert.deepEqual(sent, [1, 2]);
  c.push(3);
  c.close();
  assert.equal(timers.waiting, 0);
  c.push(4);
  assert.deepEqual(sent, [1, 2]);
});
