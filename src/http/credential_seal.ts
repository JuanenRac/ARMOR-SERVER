/**
 * A secret sealed for one node. The login of a device of the network crosses plain HTTP to the node that inspects it, so it is sealed with a key made from that node's own token:
 * a keystream from HMAC-SHA256 (nonce and block counter) xor-ed over the text, and an HMAC-SHA256 tag over nonce and cipher text that is checked before anything is opened. The node
 * opens it with the Python standard library alone (ARMOR-NETWORK, seal.py); both sides must give the same bytes for the same input, and a test holds the format.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const subKey = (token: string, label: string): Buffer => createHmac("sha256", token).update(`armor-seal:${label}`).digest();

function stream(key: Buffer, nonce: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  for (let counter = 0; blocks.length * 32 < length; counter += 1) {
    const index = Buffer.alloc(4);
    index.writeUInt32BE(counter);
    blocks.push(createHmac("sha256", key).update(nonce).update(index).digest());
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** `nonce(16) | cipher text | tag(32)`, base64. `nonce` is only for the tests. */
export function sealFor(nodeToken: string, text: string, nonce: Buffer = randomBytes(16)): string {
  const plain = Buffer.from(text, "utf8");
  const cipher = Buffer.alloc(plain.length);
  const keys = stream(subKey(nodeToken, "enc"), nonce, plain.length);
  for (let i = 0; i < plain.length; i += 1) cipher[i] = plain[i]! ^ keys[i]!;
  const tag = createHmac("sha256", subKey(nodeToken, "mac")).update(nonce).update(cipher).digest();
  return Buffer.concat([nonce, cipher, tag]).toString("base64");
}

/** The inverse, for the tests (the node does it in Python); null when the tag does not match. */
export function openSealed(nodeToken: string, sealed: string): string | null {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 48) return null;
  const nonce = raw.subarray(0, 16), cipher = raw.subarray(16, raw.length - 32), tag = raw.subarray(raw.length - 32);
  const expected = createHmac("sha256", subKey(nodeToken, "mac")).update(nonce).update(cipher).digest();
  if (!timingSafeEqual(tag, expected)) return null;
  const keys = stream(subKey(nodeToken, "enc"), nonce, cipher.length);
  return Buffer.from(cipher.map((byte, i) => byte ^ keys[i]!)).toString("utf8");
}
