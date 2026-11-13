/**
 * The end-to-end signature of the critical commands (`alarm_command` and `electrical_command`). The broker's access list already limits who may publish a command; this makes a command
 * one that only this server could have made, so that neither the broker nor another identity on it can forge or replay one. While the security option `commands.require_sig` is on,
 * every such command is published with a `nonce` (sixteen random hex digits, never reused) and a `sig`: HMAC-SHA256, in hex, of
 *
 *   armor-command|kind|node_id|timestamp_ms|command_id|nonce|fields
 *
 * where `fields` is the JSON of every other field of the command, with the keys in alphabetical order at every level, no spaces. The key is a file of this server (`command-signature.key`,
 * 64 hex digits, 0600, made the first time it is needed) that never travels on the broker; it is a different key from the one that signs the alarm states. A node that holds the key checks the
 * signature and the freshness of `timestamp_ms`, and keeps the recent nonces: that is the node's part, which is not in the firmware yet (see the changelog of the nodes). With the option off
 * (the default) the commands are published as before, with no signature.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { durableRename } from "./durable.js";

export const SIGNED_COMMAND_KINDS = ["alarm_command", "electrical_command"] as const;
export type SignedCommandKind = typeof SIGNED_COMMAND_KINDS[number];

/** JSON with the keys in alphabetical order at every level (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The bytes a command is signed over (see the format above). */
export function commandCanonical(command: Record<string, unknown>, nonce: string): string {
  const { kind, node_id, timestamp_ms, command_id, sig: _sig, nonce: _nonce, ...rest } = command;
  return ["armor-command", String(kind), String(node_id), String(timestamp_ms), String(command_id), nonce, canonicalJson(rest)].join("|");
}

export function commandSignature(keyHex: string, command: Record<string, unknown>, nonce: string): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(commandCanonical(command, nonce), "utf8").digest("hex");
}

export class CommandSigner {
  #key: string | undefined;

  /** `file` holds the key as 64 hex digits (0600); it is made the first time a command is signed, never before. */
  constructor(private readonly file: string, private readonly random: () => string = () => randomBytes(8).toString("hex")) {
    this.#key = this.#read();
  }

  #read(): string | undefined {
    try { const text = fs.readFileSync(this.file, "utf8").trim(); return /^[0-9a-f]{64}$/.test(text) ? text : undefined; } catch { return undefined; }
  }

  #ensure(): string {
    if (this.#key) return this.#key;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600 });
    durableRename(temporary, this.file);
    this.#key = this.#read();
    if (!this.#key) throw new Error("the key of the commands cannot be read");
    return this.#key;
  }

  /** The command with `nonce` and `sig` added. Throws when the key cannot be made or read (the command is then not sent). */
  sign<T extends Record<string, unknown>>(command: T): T & { nonce: string; sig: string } {
    const key = this.#ensure();
    const nonce = this.random();
    return { ...command, nonce, sig: commandSignature(key, command, nonce) };
  }

  /** Whether a command carries the signature of this installation (for the simulator and the tests; a node does the same with its copy of the key). */
  verify(command: unknown): boolean {
    if (!this.#key || typeof command !== "object" || command === null) return false;
    const { sig, nonce } = command as Record<string, unknown>;
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig) || typeof nonce !== "string" || !/^[0-9a-f]{16}$/.test(nonce)) return false;
    try { return timingSafeEqual(Buffer.from(commandSignature(this.#key, command as Record<string, unknown>, nonce), "hex"), Buffer.from(sig, "hex")); } catch { return false; }
  }
}
