/**
 * Studio users: who may sign in, with which role, and how their password is kept. Passwords are never stored: only a salted scrypt
 * hash. The first start seeds an administrator from ARMOR_STUDIO_USERNAME / ARMOR_STUDIO_PASSWORD; after that the file in the data
 * directory is the source of truth, so a name or password changed in Studio is not undone by a restart.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** An administrator manages users as well as operating; an operator only operates. */
export type Role = "admin" | "operator";
export const ROLES: readonly Role[] = ["admin", "operator"];
export type PublicUser = { id: string; username: string; role: Role; createdAt: string; updatedAt: string };
type UserRecord = PublicUser & { salt: string; hash: string };

export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,39}$/;
export const MAX_USERS = 50;
const MAX_PASSWORD_LENGTH = 200;

/** A rule the request broke: `code` is stable for clients, `status` is the HTTP answer. */
export class UserError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409) { super(message); }
}

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

  constructor(options: UserStoreOptions) {
    this.#options = options;
    this.#load();
    this.#seed();
  }

  get minPasswordLength(): number { return this.#options.minPasswordLength; }

  #now(): string { return (this.#options.now?.() ?? new Date()).toISOString(); }

  #load(): void {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.#options.file, "utf8")); } catch { return; }
    const list = (raw as { users?: unknown } | null)?.users;
    if (!Array.isArray(list)) return;
    for (const item of list.slice(0, MAX_USERS)) {
      const user = item as Partial<UserRecord>;
      if (typeof user?.id === "string" && typeof user.username === "string" && USERNAME_PATTERN.test(user.username) && ROLES.includes(user.role as Role)
        && typeof user.salt === "string" && typeof user.hash === "string" && !this.#users.some(other => same(other.username, user.username!))) {
        this.#users.push({ id: user.id, username: user.username, role: user.role as Role, salt: user.salt, hash: user.hash, createdAt: String(user.createdAt ?? this.#now()), updatedAt: String(user.updatedAt ?? this.#now()) });
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
      fs.renameSync(temporary, file);
    } catch (error) {
      this.#options.warn?.(`the users file could not be written: ${(error as Error).message}`);
      throw new Error("the users file could not be written");
    }
  }

  static #view(user: UserRecord): PublicUser { return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt }; }

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
    if (!ROLES.includes(role as Role)) throw new UserError("invalid_role", "the role is admin or operator", 400);
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

  #admins(): number { return this.#users.filter(user => user.role === "admin").length; }
}
