/**
 * Trusted phones: a phone keeps a key pair that never leaves it, the server keeps the public half, and a longer session is handed out only to a phone that proves it holds the private
 * half by signing a one-time challenge. An administrator can end a phone at any time. The whole thing is off until an administrator turns on `client.trusted_devices`.
 *   register    the signed-in person gives a name and the public key (ECDSA P-256, DER SubjectPublicKeyInfo in base64)
 *   challenge   a random value for one try, valid for one minute, tied to one device
 *   verify      the signature (ECDSA with SHA-256, DER) over "armor-device-trust-v1|<device id>|<challenge>"
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import fs from "node:fs";
import { durableRename } from "./durable.js";

export type TrustedDevice = { id: string; userId: string; name: string; publicKey: string; createdAt: string; lastUsedAt?: string };
export type TrustedDeviceView = { id: string; user_id: string; name: string; created_at: string; last_used_at: string | null };

/** At most this many phones per person, and this many in all (the file stays small). */
export const TRUSTED_PER_USER = 5;
export const TRUSTED_TOTAL = 100;
export const TRUSTED_CHALLENGE_MS = 60_000;
const PUBLIC_KEY_MAX = 200;

export const signedText = (id: string, challenge: string): string => `armor-device-trust-v1|${id}|${challenge}`;

/** The key as a clean base64 DER if it is an ECDSA P-256 public key; undefined for anything else. */
export function cleanPublicKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 40 || value.length > PUBLIC_KEY_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? value : undefined;
  } catch { return undefined; }
}

export class TrustedDevices {
  readonly #file: string;
  readonly #now: () => number;
  #devices: TrustedDevice[] = [];
  readonly #challenges = new Map<string, { challenge: string; until: number }>();

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { devices?: unknown };
      for (const item of Array.isArray(raw.devices) ? raw.devices : []) {
        const d = item as Partial<TrustedDevice>;
        const key = cleanPublicKey(d.publicKey);
        if (typeof d.id === "string" && /^[0-9a-f]{24}$/.test(d.id) && typeof d.userId === "string" && typeof d.name === "string" && key && typeof d.createdAt === "string") {
          this.#devices.push({ id: d.id, userId: d.userId, name: d.name.slice(0, 60), publicKey: key, createdAt: d.createdAt, ...(typeof d.lastUsedAt === "string" ? { lastUsedAt: d.lastUsedAt } : {}) });
        }
      }
    } catch { /* no file, or one that cannot be read: no trusted phones */ }
  }

  #save(): void {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, devices: this.#devices }), { encoding: "utf8", mode: 0o600 });
    durableRename(temporary, this.#file);
  }

  static view(device: TrustedDevice): TrustedDeviceView {
    return { id: device.id, user_id: device.userId, name: device.name, created_at: device.createdAt, last_used_at: device.lastUsedAt ?? null };
  }

  list(userId?: string): TrustedDevice[] { return this.#devices.filter(device => userId === undefined || device.userId === userId); }
  get(id: string): TrustedDevice | undefined { return this.#devices.find(device => device.id === id); }

  /** Registers a phone; "limit" when the person (or the server) has too many, "bad_key" or "bad_name" for a value that is not accepted. */
  register(userId: string, name: unknown, publicKey: unknown): TrustedDevice | "limit" | "bad_key" | "bad_name" {
    const label = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) : "";
    if (!label) return "bad_name";
    const key = cleanPublicKey(publicKey);
    if (!key) return "bad_key";
    const same = this.#devices.find(device => device.userId === userId && device.publicKey === key);
    if (same) return same;
    if (this.list(userId).length >= TRUSTED_PER_USER || this.#devices.length >= TRUSTED_TOTAL) return "limit";
    const device: TrustedDevice = { id: randomBytes(12).toString("hex"), userId, name: label, publicKey: key, createdAt: new Date(this.#now()).toISOString() };
    this.#devices.push(device);
    this.#save();
    return device;
  }

  remove(id: string): boolean {
    const before = this.#devices.length;
    this.#devices = this.#devices.filter(device => device.id !== id);
    this.#challenges.delete(id);
    if (this.#devices.length === before) return false;
    this.#save();
    return true;
  }

  /** Forgets the phones of a person (the person was removed). */
  removeUser(userId: string): void {
    const before = this.#devices.length;
    this.#devices = this.#devices.filter(device => device.userId !== userId);
    if (this.#devices.length !== before) this.#save();
  }

  /** A one-time value for this device; asking again replaces the earlier one. Undefined when there is no such device. */
  challenge(id: string): string | undefined {
    if (!this.get(id)) return undefined;
    const now = this.#now();
    for (const [key, item] of this.#challenges) if (item.until <= now) this.#challenges.delete(key);
    const challenge = randomBytes(24).toString("base64url");
    this.#challenges.set(id, { challenge, until: now + TRUSTED_CHALLENGE_MS });
    return challenge;
  }

  /** Whether `signature` (base64 DER) is the signature of the open challenge by this device. The challenge is used up whatever the answer. */
  prove(id: string, challenge: unknown, signature: unknown): TrustedDevice | undefined {
    const device = this.get(id);
    const open = this.#challenges.get(id);
    this.#challenges.delete(id);
    if (!device || !open || open.until <= this.#now() || typeof challenge !== "string" || challenge !== open.challenge) return undefined;
    if (typeof signature !== "string" || signature.length < 8 || signature.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return undefined;
    try {
      const key = createPublicKey({ key: Buffer.from(device.publicKey, "base64"), format: "der", type: "spki" });
      if (!verify("sha256", Buffer.from(signedText(id, challenge), "utf8"), key, Buffer.from(signature, "base64"))) return undefined;
    } catch { return undefined; }
    device.lastUsedAt = new Date(this.#now()).toISOString();
    this.#save();
    return device;
  }
}
