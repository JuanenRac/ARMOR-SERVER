/**
 * The staged rollout of the firmware: instead of sending a new version to every node of a job at once, an administrator can choose the channel the version comes from (`stable`: the
 * latest release; `beta`: the newest release, a pre-release included) and the share of the nodes that take it now. It is behind a security option (`admin.firmware_rollout`, off by
 * default: a job updates every node it was given, with the latest release, exactly as before).
 *
 * The settings live in the file `firmware-rollout.json`: `channel`, `percent` (1 to 100), `rollback` (a node that took the image and did not come back with it is asked to start from its
 * previous slot again) and `halt_on_failure` (after a node failed, the nodes still to come are left alone). The nodes of a job are put in a fixed order by a hash of their id and of the
 * version, so for one version the same nodes go first, and a larger percent in a later job only adds nodes; the nodes left out are listed as deferred, never touched.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { durableRename } from "./durable.js";

export class RolloutInvalid extends Error {
  constructor(message: string, readonly code = "invalid_settings") { super(message); }
}

export type RolloutChannel = "stable" | "beta";
export type RolloutSettings = { channel: RolloutChannel; percent: number; rollback: boolean; halt_on_failure: boolean };
export const DEFAULT_ROLLOUT: RolloutSettings = { channel: "stable", percent: 100, rollback: true, halt_on_failure: true };

/** Checks the settings an administrator sent (any subset of them) on top of `base`; a key that is not one of the settings, or a value out of range, is refused. */
export function parseRolloutSettings(value: unknown, base: RolloutSettings = DEFAULT_ROLLOUT): RolloutSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RolloutInvalid("the settings must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(key in DEFAULT_ROLLOUT)) throw new RolloutInvalid(`unknown setting ${key}`);
  const out: RolloutSettings = { ...base };
  if ("channel" in input) {
    if (input.channel !== "stable" && input.channel !== "beta") throw new RolloutInvalid("channel must be stable or beta");
    out.channel = input.channel;
  }
  if ("percent" in input) {
    const percent = input.percent;
    if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 100) throw new RolloutInvalid("percent must be a whole number from 1 to 100");
    out.percent = percent;
  }
  for (const key of ["rollback", "halt_on_failure"] as const) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "boolean") throw new RolloutInvalid(`${key} must be true or false`);
    out[key] = input[key] as boolean;
  }
  return out;
}

/** Where a node stands in the order of a version, 0 to 4294967295: the first four bytes of the SHA-256 of its id and the version. */
export function rolloutRank(nodeId: string, version: string): number {
  return crypto.createHash("sha256").update(`${nodeId}|${version}`, "utf8").digest().readUInt32BE(0);
}

/** How many of `count` nodes go in a wave of `percent`: the share rounded up, and at least one node while there is one. */
export function waveSize(count: number, percent: number): number {
  if (count <= 0) return 0;
  return Math.min(count, Math.max(1, Math.ceil(count * percent / 100)));
}

/**
 * Splits the nodes of a job into the ones that go now and the ones that wait. The ones that go keep the order of the rank, so the first of them is always the same node for a
 * version (the one that tries the image first); the ones that wait keep it too. `key` is the id of the node, or its address when the id is not known.
 */
export function splitWave<T>(nodes: readonly T[], key: (node: T) => string, version: string, percent: number): { now: T[]; deferred: T[] } {
  const ranked = nodes.map((node, index) => ({ node, index, rank: rolloutRank(key(node), version) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const size = waveSize(ranked.length, percent);
  return { now: ranked.slice(0, size).map(item => item.node), deferred: ranked.slice(size).map(item => item.node) };
}

/** The settings of the staged rollout, kept in a file. */
export class RolloutStore {
  #settings: RolloutSettings = { ...DEFAULT_ROLLOUT };

  constructor(private readonly file: string, private readonly warn: (message: string) => void = () => undefined) {
    try {
      const text = fs.readFileSync(file, "utf8");
      this.#settings = parseRolloutSettings(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`the settings of the firmware rollout could not be read (${error instanceof Error ? error.message : "unknown error"}); the defaults are used`);
    }
  }

  get(): RolloutSettings { return { ...this.#settings }; }

  /** Saves the settings, changing only the keys given. */
  set(value: unknown): RolloutSettings {
    this.#settings = parseRolloutSettings(value, this.#settings);
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.#settings, null, 2)}\n`, { mode: 0o600 });
    durableRename(temporary, this.file);
    return this.get();
  }
}
