/**
 * Second factor for the sign-in: a time-based one-time code (RFC 6238: the six digits of Google Authenticator, Aegis, and the like) and ten recovery codes for the day the phone is lost.
 * The secret of a user is kept encrypted (AES-256-GCM, a key derived from the installation's secret under its own label) in a file written atomically; the recovery codes are kept only as
 * hashes; a code that was accepted once is not accepted again (no replay inside its thirty seconds).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { durableRename } from "./durable.js";

const STEP_S = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const RECOVERY_CODES = 10;

export function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[\s=-]/g, "")) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The code of one thirty-second step (RFC 4226 truncation of an HMAC-SHA1 of the step counter). */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const stepOf = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_S);

const equalText = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

type Sealed = { iv: string; tag: string; data: string };
type Record_ = { secret?: Sealed; pending?: Sealed; recovery: string[]; lastStep: number; enabledAt?: string };

const keyOf = (secret: string): Buffer => createHash("sha256").update(`armor-totp/v1\0${secret}`).digest();
function seal(value: Buffer, key: Buffer): Sealed {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function open(sealed: Sealed | undefined, key: Buffer): Buffer | undefined {
  if (!sealed) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]);
  } catch { return undefined; }
}
const recoveryHash = (code: string): string => createHash("sha256").update(`armor-recovery/v1\0${code.replace(/[\s-]/g, "").toLowerCase()}`).digest("hex");

export class TotpStore {
  readonly #records = new Map<string, Record_>();
  readonly #file: string;
  readonly #key: Buffer;
  readonly #now: () => number;
  /** Wrong codes in a row per user, in memory: five and the next tries wait. */
  readonly #fails = new Map<string, { count: number; until: number }>();

  constructor(options: { file: string; secret: string; now?: () => number }) {
    this.#file = options.file; this.#key = keyOf(options.secret); this.#now = options.now ?? Date.now;
    try {
      const saved = JSON.parse(fs.readFileSync(this.#file, "utf8")) as { users?: Record<string, Record_> };
      for (const [id, record] of Object.entries(saved.users ?? {})) if (record && Array.isArray(record.recovery)) this.#records.set(id, { recovery: record.recovery.filter(item => typeof item === "string"), lastStep: Number(record.lastStep) || 0, secret: record.secret, pending: record.pending, enabledAt: record.enabledAt });
    } catch { /* no file yet */ }
  }

  #persist(): void {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, users: Object.fromEntries(this.#records) }), { encoding: "utf8", mode: 0o600 });
    durableRename(temporary, this.#file);
  }

  enabled(userId: string): boolean { return Boolean(this.#records.get(userId)?.secret); }

  /** A new secret that is not in force until a code made from it is confirmed. */
  begin(userId: string, username: string): { secret: string; uri: string } {
    const secret = randomBytes(20);
    const record = this.#records.get(userId) ?? { recovery: [], lastStep: 0 };
    record.pending = seal(secret, this.#key);
    this.#records.set(userId, record);
    this.#persist();
    const text = base32(secret);
    return { secret: text, uri: `otpauth://totp/ARMOR:${encodeURIComponent(username)}?secret=${text}&issuer=ARMOR&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}` };
  }

  /** The first code of the new secret turns the second factor on, and the recovery codes are given once. Undefined when the code is not right. */
  confirm(userId: string, code: string): string[] | undefined {
    const record = this.#records.get(userId);
    const secret = open(record?.pending, this.#key);
    if (!record || !secret) return undefined;
    const step = this.#match(secret, code, 0);
    if (step === undefined) return undefined;
    const codes = Array.from({ length: RECOVERY_CODES }, () => { const raw = randomBytes(5).toString("hex"); return `${raw.slice(0, 5)}-${raw.slice(5)}`; });
    record.secret = record.pending; record.pending = undefined; record.lastStep = step; record.enabledAt = new Date(this.#now()).toISOString();
    record.recovery = codes.map(recoveryHash);
    this.#persist();
    return codes;
  }

  #match(secret: Buffer, code: string, lastStep: number): number | undefined {
    if (!/^[0-9]{6}$/.test(code)) return undefined;
    const now = stepOf(this.#now());
    for (const step of [now, now - 1, now + 1]) if (step > lastStep && equalText(totpCode(secret, step), code)) return step;
    return undefined;
  }

  /** Seconds the next try must wait after too many wrong codes (0: go ahead). */
  waitFor(userId: string): number { return Math.max(0, Math.ceil(((this.#fails.get(userId)?.until ?? 0) - this.#now()) / 1000)); }

  /** True for a code of the app (once) or an unused recovery code (which is then used up). */
  verify(userId: string, code: unknown): boolean {
    const record = this.#records.get(userId);
    const secret = open(record?.secret, this.#key);
    if (!record || !secret || typeof code !== "string" || this.waitFor(userId) > 0) return false;
    const text = code.trim();
    let good = false;
    const step = this.#match(secret, text, record.lastStep);
    if (step !== undefined) { record.lastStep = step; good = true; this.#persist(); }
    else {
      const hashed = recoveryHash(text);
      const index = record.recovery.findIndex(item => equalText(item, hashed));
      if (index >= 0) { record.recovery.splice(index, 1); good = true; this.#persist(); }
    }
    if (good) this.#fails.delete(userId);
    else {
      const state = this.#fails.get(userId) ?? { count: 0, until: 0 };
      state.count += 1;
      if (state.count >= 5) state.until = this.#now() + Math.min(3_600_000, 30_000 * 2 ** (state.count - 5));
      this.#fails.set(userId, state);
    }
    return good;
  }

  recoveryLeft(userId: string): number { return this.#records.get(userId)?.recovery.length ?? 0; }

  /** Turns the second factor off for a user (the administrator who resets it, or the person with their password). */
  disable(userId: string): void { if (this.#records.delete(userId)) this.#persist(); }
}
