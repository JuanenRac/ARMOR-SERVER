/**
 * The end-to-end signature of the critical commands (`alarm_command` and `electrical_command`). The broker's access list already limits who may publish a command; this makes a command
 * one that only this server could have made, so that neither the broker nor another identity on it can forge or replay one. While the security option `commands.require_sig` is on,
 * every such command is published with a `nonce` (sixteen random hex digits, never reused) and, last of all, a `sig`:
 *
 *   payload  = <the JSON of the command, with "nonce" as its last field> with ,"sig":"<64 hex digits>"} in place of the closing brace
 *   sig      = HMAC-SHA256(node key, "armor-command-v2|" + the payload without the sig field, closing brace included), in hex
 *   node key = HMAC-SHA256(master key, "node|" + node_id)
 *
 * The signature is over the BYTES exactly as they are published, so a node checks it by cutting the text, with no JSON to rebuild: it finds the ending `,"sig":"<64 hex>"}`, replaces it
 * by `}`, and computes the HMAC with its own key. The master key is a file of this server (`command-signature.key`, 64 hex digits, 0600, made the first time it is needed) that never
 * travels on the broker and is never given to a node: a node holds only the key of its own id, which an administrator reads once with the token of the node (see routes/admin.ts), so a
 * node that is lost or opened cannot sign for another. A node also checks that `timestamp_ms` is recent when it has a valid clock and keeps the recent nonces. With the option off (the
 * default) the commands are published as before, with no signature.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { durableRename } from "./durable.js";

export const SIGNED_COMMAND_KINDS = ["alarm_command", "electrical_command"] as const;
export type SignedCommandKind = typeof SIGNED_COMMAND_KINDS[number];
export const SIGNATURE_PREFIX = "armor-command-v2|";
const ENDING = /^([\s\S]*),"sig":"([0-9a-f]{64})"\}$/;
const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The key a node holds: HMAC-SHA256 of the master key over "node|" and the id of the node, in hex. */
export function nodeKeyOf(masterHex: string, nodeId: string): string {
  return createHmac("sha256", Buffer.from(masterHex, "hex")).update(`node|${nodeId}`, "utf8").digest("hex");
}

/** The signature of a body (the payload without its sig field, closing brace included) under a node key, in hex. */
export function bodySignature(nodeKeyHex: string, body: string): string {
  return createHmac("sha256", Buffer.from(nodeKeyHex, "hex")).update(SIGNATURE_PREFIX + body, "utf8").digest("hex");
}

/** The body and the signature of a payload that ends with a sig field; undefined when it does not. */
export function splitSigned(payload: string): { body: string; sig: string } | undefined {
  const match = ENDING.exec(payload);
  return match ? { body: `${match[1]}}`, sig: match[2] } : undefined;
}

export class CommandSigner {
  #master: string | undefined;

  /** `file` holds the master key as 64 hex digits (0600); it is made the first time a command is signed, never before. */
  constructor(private readonly file: string, private readonly random: () => string = () => randomBytes(8).toString("hex")) {
    this.#master = this.#read();
  }

  #read(): string | undefined {
    try { const text = fs.readFileSync(this.file, "utf8").trim(); return /^[0-9a-f]{64}$/.test(text) ? text : undefined; } catch { return undefined; }
  }

  #ensure(): string {
    if (this.#master) return this.#master;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600 });
    durableRename(temporary, this.file);
    this.#master = this.#read();
    if (!this.#master) throw new Error("the key of the commands cannot be read");
    return this.#master;
  }

  /** The key of one node, to be given to that node and no other. Makes the master key if there is none yet. */
  nodeKey(nodeId: string): string {
    if (!NODE_ID.test(nodeId)) throw new Error("not the id of a node");
    return nodeKeyOf(this.#ensure(), nodeId);
  }

  /** The payload to publish: the command with a nonce, then the signature of those bytes. Throws when the key cannot be made or read, or the command names no node (the command is then not sent). */
  sign(command: Record<string, unknown>): string {
    const nodeId = command.node_id;
    if (typeof nodeId !== "string") throw new Error("a command to sign names its node");
    const key = this.nodeKey(nodeId);
    const body = JSON.stringify({ ...command, nonce: this.random() });
    return `${body.slice(0, -1)},"sig":"${bodySignature(key, body)}"}`;
  }

  /** Whether a payload carries the signature of this installation for the node it names (for the simulator and the tests; a node does the same with its own key). */
  verify(payload: unknown): boolean {
    if (typeof payload !== "string" || !this.#master) return false;
    const parts = splitSigned(payload);
    if (!parts) return false;
    try {
      const document = JSON.parse(parts.body) as { node_id?: unknown; nonce?: unknown };
      if (typeof document.node_id !== "string" || typeof document.nonce !== "string" || !/^[0-9a-f]{16}$/.test(document.nonce)) return false;
      const expected = Buffer.from(bodySignature(nodeKeyOf(this.#master, document.node_id), parts.body), "hex");
      return timingSafeEqual(expected, Buffer.from(parts.sig, "hex"));
    } catch { return false; }
  }
}
