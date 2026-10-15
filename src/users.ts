/**
 * Studio users: who may sign in, with which role, and how their password is kept. Passwords are never stored: only a salted scrypt
 * hash. The first start seeds an administrator from ARMOR_STUDIO_USERNAME / ARMOR_STUDIO_PASSWORD; after that the file in the data
 * directory is the source of truth, so a name or password changed in Studio is not undone by a restart.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { durableRename, keepBackup } from "./durable.js";

/** An administrator manages users as well as operating; an operator only operates. */
/** `panel` is the account of a wall panel (ARMOR-HMI): it may read the small summary, arm and disarm the system and acknowledge alarms, and nothing else (see context.ts). */
export type Role = "admin" | "operator" | "panel";
export const ROLES: readonly Role[] = ["admin", "operator", "panel"];
/** `hasPin` / `hasDuress` say that a PIN to disarm (and a second one that disarms but warns in silence) is set; the PINs themselves are never shown. */
export type PublicUser = { id: string; username: string; role: Role; createdAt: string; updatedAt: string; hasPin: boolean; hasDuress: boolean };
type UserRecord = Omit<PublicUser, "hasPin" | "hasDuress"> & { salt: string; hash: string; pin?: { salt: string; hash: string }; duress?: { salt: string; hash: string } };
/** What a PIN typed to disarm came to. `none`: the user has no PIN. `duress`: the duress PIN, which disarms and warns in silence. */
export type PinResult = "ok" | "duress" | "bad" | "locked" | "none";

export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,39}$/;
export const MAX_USERS = 50;
const MAX_PASSWORD_LENGTH = 200;
export const PIN_PATTERN = /^[0-9]{4,10}$/;
/** Wrong PINs in a row, and how long the next tries are refused: a minute, five, fifteen, then fifteen again. */
const PIN_FAILS_BEFORE_LOCK = 3;
const PIN_LOCKS_MS = [60_000, 300_000, 900_000];

/** A rule the request broke: `code` is stable for clients, `status` is the HTTP answer. */
export class UserError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409) { super(message); }
}

const secretOf = (key: "pin" | "duress", user: Partial<UserRecord>): Partial<Pick<UserRecord, "pin" | "duress">> => {
  const value = user[key];
  return value && typeof value.salt === "string" && typeof value.hash === "string" ? { [key]: { salt: value.salt, hash: value.hash } } : {};
};
const hash = (password: string, salt: Buffer): Buffer => scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 });
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export type UserStoreOptions = {
  file: string;
  /** The administrator to create when the file does not exist (or holds no administrator). */
  seed: { username: string; password: string };
  minPasswordLength: number;
  /** When set, the seed administrator's password is reset to the configured one even if the user already exists. */
  resetSeedPassword?: boolean;
  warn?: (message: string) => void;
  now?: () => Date;
};

export class UserStore {
  readonly #options: UserStoreOptions;
  #users: UserRecord[] = [];
  /** Wrong PINs in a row and the lock, in memory only: a restart is not a way round it (a power cut is how an intruder would try) but the counter is not worth a file. */
  readonly #pinTries = new Map<string, { fails: number; locks: number; until: number }>();

  constructor(options: UserStoreOptions) {
    this.#options = options;
    this.#load();
    this.#seed();
  }

  get minPasswordLength(): number { return this.#options.minPasswordLength; }

  #now(): string { return (this.#options.now?.() ?? new Date()).toISOString(); }

  #load(): void {
    const file = this.#options.file;
    const read = (from: string): unknown[] | undefined => {
      try { const list = (JSON.parse(fs.readFileSync(from, "utf8")) as { users?: unknown } | null)?.users; return Array.isArray(list) ? list : undefined; } catch { return undefined; }
    };
    let list = read(file);
    if (list === undefined && fs.existsSync(file)) {
      // The file is there and cannot be read (a power cut in the middle of a write): never write the seed over it, which would lose every other account. The last good copy is used; with
      // none, the damaged file is put aside for somebody to look at, and only then is the seed administrator made.
      list = read(`${file}.bak`);
      if (list !== undefined) this.#options.warn?.("users.json is damaged; the last good copy (users.json.bak) is used");
      else {
        try { fs.renameSync(file, `${file}.damaged`); } catch { /* it stays where it is */ }
        this.#options.warn?.("users.json is damaged and there is no copy: it was put aside as users.json.damaged and the configured administrator is made again");
      }
    }
    if (list === undefined) return;
    for (const item of list.slice(0, MAX_USERS)) {
      const user = item as Partial<UserRecord>;
      if (typeof user?.id === "string" && typeof user.username === "string" && USERNAME_PATTERN.test(user.username) && ROLES.includes(user.role as Role)
        && typeof user.salt === "string" && typeof user.hash === "string" && !this.#users.some(other => same(other.username, user.username!))) {
        this.#users.push({ id: user.id, username: user.username, role: user.role as Role, salt: user.salt, hash: user.hash, createdAt: String(user.createdAt ?? this.#now()), updatedAt: String(user.updatedAt ?? this.#now()), ...secretOf("pin", user), ...secretOf("duress", user) });
      }
    }
  }

  #seed(): void {
    const { seed } = this.#options;
    const existing = this.#users.find(user => same(user.username, seed.username));
    if (existing && this.#options.resetSeedPassword) {
      this.#setPassword(existing, seed.password);
      this.#options.warn?.(`the password of "${existing.username}" was reset from ARMOR_STUDIO_PASSWORD`);
      this.#save();
      return;
    }
    if (this.#users.some(user => user.role === "admin")) return;
    // No administrator (a new install, or a damaged file): the configured one is created, or promoted, so Studio can never be locked out.
    if (existing) existing.role = "admin";
    else if (USERNAME_PATTERN.test(seed.username)) this.#users.push(this.#record(seed.username, seed.password, "admin"));
    else this.#options.warn?.("ARMOR_STUDIO_USERNAME is not a valid Studio user name (3 to 40 letters, digits, . _ @ -); no administrator was created");
    this.#save();
  }

  #record(username: string, password: string, role: Role): UserRecord {
    const salt = randomBytes(16), now = this.#now();
    return { id: `u-${randomBytes(6).toString("hex")}`, username, role, salt: salt.toString("base64"), hash: hash(password, salt).toString("base64"), createdAt: now, updatedAt: now };
  }

  #setPassword(user: UserRecord, password: string): void {
    const salt = randomBytes(16);
    user.salt = salt.toString("base64"); user.hash = hash(password, salt).toString("base64"); user.updatedAt = this.#now();
  }

  #save(): void {
    const { file } = this.#options;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, users: this.#users }, null, 2), { encoding: "utf8", mode: 0o600 });
      keepBackup(file);
      durableRename(temporary, file);
    } catch (error) {
      this.#options.warn?.(`the users file could not be written: ${(error as Error).message}`);
      throw new Error("the users file could not be written");
    }
  }

  static #view(user: UserRecord): PublicUser { return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt, hasPin: user.pin !== undefined, hasDuress: user.duress !== undefined }; }

  #checkUsername(username: unknown, except?: string): string {
    if (typeof username !== "string" || !USERNAME_PATTERN.test(username.trim())) throw new UserError("invalid_username", "a user name has 3 to 40 letters, digits, dots, dashes, underscores or @", 400);
    const clean = username.trim();
    if (this.#users.some(user => user.id !== except && same(user.username, clean))) throw new UserError("username_taken", "that user name is already in use", 409);
    return clean;
  }

  #checkPassword(password: unknown): string {
    if (typeof password !== "string" || password.length < this.#options.minPasswordLength) throw new UserError("weak_password", `the password needs at least ${this.#options.minPasswordLength} characters`, 400);
    if (password.length > MAX_PASSWORD_LENGTH) throw new UserError("invalid_password", "the password is too long", 400);
    return password;
  }

  #checkRole(role: unknown): Role {
    if (!ROLES.includes(role as Role)) throw new UserError("invalid_role", "the role is admin, operator or panel", 400);
    return role as Role;
  }

  list(): PublicUser[] { return this.#users.map(UserStore.#view); }
  get(id: string): PublicUser | undefined { const user = this.#users.find(item => item.id === id); return user ? UserStore.#view(user) : undefined; }

  /** The user for a correct name and password. Takes the same time whether or not the name exists. */
  authenticate(username: string, password: string): PublicUser | null {
    const user = this.#users.find(item => same(item.username, username));
    const salt = Buffer.from(user?.salt ?? "AAAAAAAAAAAAAAAAAAAAAA==", "base64");
    const expected = Buffer.from(user?.hash ?? Buffer.alloc(64).toString("base64"), "base64");
    const actual = hash(typeof password === "string" ? password.slice(0, MAX_PASSWORD_LENGTH) : "", salt);
    return user && expected.length === actual.length && timingSafeEqual(expected, actual) ? UserStore.#view(user) : null;
  }

  create(input: { username: unknown; password: unknown; role: unknown }): PublicUser {
    if (this.#users.length >= MAX_USERS) throw new UserError("too_many_users", `at most ${MAX_USERS} users`, 409);
    const username = this.#checkUsername(input.username), password = this.#checkPassword(input.password), role = this.#checkRole(input.role);
    const user = this.#record(username, password, role);
    this.#users.push(user);
    this.#save();
    return UserStore.#view(user);
  }

  /** Change any of the name, the password and the role; the last administrator can neither lose the role nor be removed. */
  update(id: string, input: { username?: unknown; password?: unknown; role?: unknown }): { user: PublicUser; passwordChanged: boolean; roleChanged: boolean } {
    const user = this.#users.find(item => item.id === id);
    if (!user) throw new UserError("not_found", "no such user", 404);
    const before = { username: user.username, role: user.role, salt: user.salt, hash: user.hash, updatedAt: user.updatedAt };
    try {
      if (input.username !== undefined) user.username = this.#checkUsername(input.username, id);
      if (input.role !== undefined) {
        const role = this.#checkRole(input.role);
        if (user.role === "admin" && role !== "admin" && this.#admins() <= 1) throw new UserError("last_admin", "there must always be one administrator", 409);
        user.role = role;
      }
      if (input.password !== undefined) this.#setPassword(user, this.#checkPassword(input.password));
      user.updatedAt = this.#now();
      this.#save();
    } catch (error) {
      Object.assign(user, before);
      throw error;
    }
    return { user: UserStore.#view(user), passwordChanged: input.password !== undefined, roleChanged: input.role !== undefined && input.role !== before.role };
  }

  remove(id: string): void {
    const user = this.#users.find(item => item.id === id);
    if (!user) throw new UserError("not_found", "no such user", 404);
    if (user.role === "admin" && this.#admins() <= 1) throw new UserError("last_admin", "there must always be one administrator", 409);
    this.#users = this.#users.filter(item => item.id !== id);
    this.#save();
  }

  /** Sets the PIN that disarms the system, and optionally a second one that disarms it while warning in silence (somebody being forced). Four to ten digits; the two must differ. */
  setPin(id: string, pin: unknown, duress?: unknown): PublicUser {
    const user = this.#users.find(item => item.id === id);
    if (!user) throw new UserError("not_found", "no such user", 404);
    if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) throw new UserError("invalid_pin", "a PIN has 4 to 10 digits", 400);
    if (duress !== undefined && duress !== null && duress !== "" && (typeof duress !== "string" || !PIN_PATTERN.test(duress))) throw new UserError("invalid_pin", "a PIN has 4 to 10 digits", 400);
    const wantsDuress = typeof duress === "string" && duress !== "";
    if (wantsDuress && duress === pin) throw new UserError("same_pin", "the duress PIN must differ from the PIN", 400);
    const keep = { pin: user.pin, duress: user.duress, updatedAt: user.updatedAt };
    const made = (value: string) => { const salt = randomBytes(16); return { salt: salt.toString("base64"), hash: hash(value, salt).toString("base64") }; };
    try {
      user.pin = made(pin);
      if (wantsDuress) user.duress = made(duress as string); else delete user.duress;
      user.updatedAt = this.#now();
      this.#pinTries.delete(id);
      this.#save();
    } catch (error) { Object.assign(user, keep); throw error; }
    return UserStore.#view(user);
  }

  clearPin(id: string): PublicUser {
    const user = this.#users.find(item => item.id === id);
    if (!user) throw new UserError("not_found", "no such user", 404);
    delete user.pin; delete user.duress;
    user.updatedAt = this.#now();
    this.#pinTries.delete(id);
    this.#save();
    return UserStore.#view(user);
  }

  /** Checks a PIN typed to disarm. Three wrong ones in a row lock the user for a minute, then five, then fifteen; a right one (either) clears the count. Takes the same work whichever PIN it is. */
  verifyPin(id: string, pin: unknown, nowMs: number = Date.now()): PinResult {
    const user = this.#users.find(item => item.id === id);
    if (!user || !user.pin) return "none";
    const tries = this.#pinTries.get(id) ?? { fails: 0, locks: 0, until: 0 };
    if (nowMs < tries.until) return "locked";
    const typed = typeof pin === "string" && pin.length <= 12 ? pin : "";
    const matches = (record: { salt: string; hash: string } | undefined): boolean => {
      const salt = Buffer.from(record?.salt ?? "AAAAAAAAAAAAAAAAAAAAAA==", "base64");
      const expected = Buffer.from(record?.hash ?? Buffer.alloc(64).toString("base64"), "base64");
      const actual = hash(typed, salt);
      return record !== undefined && typed !== "" && expected.length === actual.length && timingSafeEqual(expected, actual);
    };
    const isPin = matches(user.pin), isDuress = matches(user.duress);
    if (isPin || isDuress) { this.#pinTries.delete(id); return isDuress ? "duress" : "ok"; }
    tries.fails += 1;
    if (tries.fails >= PIN_FAILS_BEFORE_LOCK) { tries.until = nowMs + PIN_LOCKS_MS[Math.min(tries.locks, PIN_LOCKS_MS.length - 1)]; tries.locks += 1; tries.fails = 0; }
    this.#pinTries.set(id, tries);
    return tries.until > nowMs ? "locked" : "bad";
  }

  /** Seconds left of a lock (0 when there is none). */
  pinLockedFor(id: string, nowMs: number = Date.now()): number { return Math.max(0, Math.ceil(((this.#pinTries.get(id)?.until ?? 0) - nowMs) / 1000)); }

  #admins(): number { return this.#users.filter(user => user.role === "admin").length; }
}
