/**
 * The logins an administrator keeps for the web administration of the devices of the network (a router, a camera, a NAS), so that "look at it with its login" can be ordered
 * without typing them again. They are kept encrypted (AES-256-GCM, a key derived from the same secret as the cameras', under its own label) in a file written atomically, are
 * never sent to Studio (only the user name and the fact that there is one), and leave the server only inside one `inspect` order to the node, handed out once.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DeviceLogin = { user: string; password: string };
type Stored = { iv: string; tag: string; ciphertext: string };
export class CredentialsInvalid extends Error {}

const DEVICE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const keyOf = (secret: string): Buffer => createHash("sha256").update(`armor-device-logins/v1\0${secret}`).digest();

function seal(login: DeviceLogin, key: Buffer): Stored {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(login), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function open(stored: Stored, key: Buffer): DeviceLogin | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]).toString("utf8")) as DeviceLogin;
    return typeof value.user === "string" && typeof value.password === "string" ? value : undefined;
  } catch { return undefined; }
}

export class DeviceCredentials {
  readonly #logins = new Map<string, Stored>();
  readonly #file: string;
  readonly #key: Buffer;

  constructor(options: { file: string; secret: string }) {
    this.#file = options.file;
    this.#key = keyOf(options.secret);
    try {
      const saved = JSON.parse(fs.readFileSync(this.#file, "utf8")) as { logins?: Record<string, Stored> };
      for (const [id, stored] of Object.entries(saved.logins ?? {})) if (DEVICE.test(id) && open(stored, this.#key)) this.#logins.set(id, stored);   // one that cannot be read is dropped
    } catch { /* no file yet */ }
  }

  /** Keep the login of a device. The password may be empty (some devices have none); the user may not. */
  set(deviceId: string, input: unknown): void {
    if (!DEVICE.test(deviceId)) throw new CredentialsInvalid("invalid device id");
    const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    const user = typeof value.user === "string" ? value.user.trim() : "", password = typeof value.password === "string" ? value.password : "";
    if (!user || user.length > 64 || /[\r\n\0]/.test(user)) throw new CredentialsInvalid("the user is 1 to 64 characters");
    if (password.length > 128 || /[\r\n\0]/.test(password)) throw new CredentialsInvalid("the password is at most 128 characters");
    if (!this.#logins.has(deviceId) && this.#logins.size >= 500) throw new CredentialsInvalid("too many devices have a login");
    this.#logins.set(deviceId, seal({ user, password }, this.#key));
    this.#persist();
  }

  /** What may be shown: whether a login exists and its user name, never the password. */
  summary(deviceId: string): { user: string } | undefined {
    const stored = this.#logins.get(deviceId);
    const login = stored ? open(stored, this.#key) : undefined;
    return login ? { user: login.user } : undefined;
  }

  /** The login itself, only for the order that needs it. */
  get(deviceId: string): DeviceLogin | undefined {
    const stored = this.#logins.get(deviceId);
    return stored ? open(stored, this.#key) : undefined;
  }

  remove(deviceId: string): boolean {
    const removed = this.#logins.delete(deviceId);
    if (removed) this.#persist();
    return removed;
  }

  all(): string[] { return [...this.#logins.keys()]; }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, logins: Object.fromEntries(this.#logins) }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.#file);
  }
}
