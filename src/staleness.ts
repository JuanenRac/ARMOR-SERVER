/**
 * The silence of a node, the same rule for every family that keeps what its nodes last said (electrical, alarm, network, solar): an entry that has said nothing for longer than the time
 * it is allowed to be quiet is marked stale and told once; the first message after that brings it back (each store does that where it takes the message).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type Stalable = { stale: boolean; receivedAtMs: number };

/** Marks as stale, and tells once, every entry quiet for longer than `afterMs`; `skip` leaves out the entries that are not real nodes (the examples of the solar page). */
export function sweepStale<T extends Stalable>(entries: Iterable<T>, now: number, afterMs: number, tell: (entry: T) => void, skip: (entry: T) => boolean = () => false): void {
  for (const entry of entries) {
    if (entry.stale || skip(entry) || now - entry.receivedAtMs <= afterMs) continue;
    entry.stale = true;
    tell(entry);
  }
}
