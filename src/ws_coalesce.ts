/**
 * Many changes in a burst (a dozen nodes reporting in the same second) would send the whole state to every console once per change, and the console only needs the newest state: this
 * keeps the latest one and sends it at most once per window, so a burst costs one message, and a quiet moment still delivers within one window.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type Coalescer<T> = {
  /** Remember `value` as the newest state; it is sent when the window ends (or at once when nothing was sent in the last window). */
  push(value: T): void;
  /** Send the pending state now, if there is one. */
  flush(): void;
  /** Stop the timer without sending (the server is closing). */
  close(): void;
};

export function createCoalescer<T>(send: (value: T) => void, windowMs: number, timers: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = { set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref(); return handle; }, clear: handle => clearTimeout(handle as NodeJS.Timeout) }): Coalescer<T> {
  let pending: { value: T } | undefined;
  let timer: unknown;
  let closed = false;
  const fire = (): void => {
    timer = undefined;
    if (!pending) return;
    const { value } = pending;
    pending = undefined;
    send(value);
    // A change that arrives right after a send waits a full window: that is what keeps a burst to one message per window.
    timer = timers.set(fire, windowMs);
  };
  return {
    push(value: T): void {
      if (closed) return;
      pending = { value };
      if (timer === undefined) fire();
    },
    flush(): void {
      if (closed || !pending) return;
      if (timer !== undefined) { timers.clear(timer); timer = undefined; }
      fire();
    },
    close(): void {
      closed = true;
      pending = undefined;
      if (timer !== undefined) { timers.clear(timer); timer = undefined; }
    },
  };
}
