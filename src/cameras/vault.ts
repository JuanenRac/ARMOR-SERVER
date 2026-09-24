/**
 * A.R.M.O.R. camera vault: the registry of configured cameras, with passwords
 * encrypted (AES-256-GCM) in a versioned file that is written atomically.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CameraConnection, CameraSecrets } from "./model.js";

type StoredSecrets = { iv: string; tag: string; ciphertext: string };
type StoredCamera = Omit<CameraConnection, "secrets"> & { secrets?: StoredSecrets };

const deriveKey = (secret: string): Buffer => createHash("sha256").update(`armor-camera-config/v1\0${secret}`).digest();

export function encryptSecrets(secrets: CameraSecrets, key: Buffer): StoredSecrets {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptSecrets(stored: StoredSecrets, key: Buffer): CameraSecrets | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]).toString("utf8")) as CameraSecrets;
    return typeof value.username === "string" && typeof value.password === "string" ? value : undefined;
  } catch { return undefined; }
}

export type VaultOptions = {
  file: string;
  /** The dedicated camera key (or, for migration only, the control token). */
  secret: string;
  /** Set when the key above is the dedicated one: earlier releases used the control token. */
  legacySecret?: string;
  warn?: (message: string) => void;
};

export class CameraVault {
  readonly #cameras = new Map<string, CameraConnection>();
  readonly #file: string;
  readonly #key: Buffer;
  readonly #legacyKey: Buffer | undefined;
  readonly #warn: (message: string) => void;

  constructor(options: VaultOptions) {
    this.#file = options.file;
    this.#key = deriveKey(options.secret);
    this.#legacyKey = options.legacySecret ? deriveKey(options.legacySecret) : undefined;
    this.#warn = options.warn ?? (() => undefined);
    this.#restore();
  }

  list(): CameraConnection[] { return [...this.#cameras.values()]; }
  get(id: string): CameraConnection | undefined { return this.#cameras.get(id); }

  save(camera: CameraConnection): void { this.#cameras.set(camera.id, camera); this.#persist(); }
  remove(id: string): boolean { const removed = this.#cameras.delete(id); if (removed) this.#persist(); return removed; }

  #persist(): void {
    const stored: StoredCamera[] = this.list().map(camera => {
      const { secrets, ...rest } = camera;
      return { ...rest, ...(secrets ? { secrets: encryptSecrets(secrets, this.#key) } : {}) };
    });
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, cameras: stored }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.#file);
  }

  #restore(): void {
    let parsed: { schema?: number; cameras?: StoredCamera[] };
    try { parsed = JSON.parse(fs.readFileSync(this.#file, "utf8")); } catch { return; /* First run: no cameras. */ }
    if (parsed.schema !== 1 || !Array.isArray(parsed.cameras)) { this.#warn("camera file ignored: unknown schema"); return; }
    let migrated = 0;
    let unreadable = 0;
    for (const stored of parsed.cameras) {
      if (!stored || !stored.id || !stored.name || !stored.host) continue;
      const { secrets, ...rest } = stored;
      let plain: CameraSecrets | undefined;
      if (secrets) {
        plain = decryptSecrets(secrets, this.#key);
        if (!plain && this.#legacyKey) {
          plain = decryptSecrets(secrets, this.#legacyKey);
          if (plain) migrated += 1;
        }
        // Keep the camera without its credentials rather than dropping it: the
        // operator can enter the password again.
        if (!plain) unreadable += 1;
      }
      this.#cameras.set(stored.id, { ...rest, secrets: plain });
    }
    if (migrated) { this.#persist(); this.#warn(`ARMOR_CAMERA_CONFIG_MIGRATED count=${migrated}`); }
    if (unreadable) this.#warn(`ARMOR_CAMERA_CONFIG_UNREADABLE count=${unreadable} (the camera key changed; re-enter those passwords)`);
  }
}
