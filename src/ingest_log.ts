/**
 * What the broker (and the HTTP routes) hand to the server, kept so a person can see why a node does not show up: per topic, how many messages were taken, how many were refused,
 * which fields a newer node sent that this server does not know (they are ignored, never a reason to refuse), and the last refusal with the start of what was sent.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type IngestEntry = {
  topic: string; accepted: number; rejected: number;
  /** The fields of the messages that the contract of this server does not define (a node newer than the server): dropped, and listed here. */
  ignored_fields: string[];
  last_ok_at: string | null; last_error: string | null; last_error_at: string | null; last_payload: string | null;
};

const MAX_TOPICS = 200, MAX_IGNORED = 24, EXCERPT = 400;
const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length)}…` : text);

export class IngestLog {
  readonly #entries = new Map<string, IngestEntry>();
  readonly #now: () => number;
  constructor(now: () => number = () => Date.now()) { this.#now = now; }

  #entry(topic: string): IngestEntry | undefined {
    const key = clip(topic, 120);
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= MAX_TOPICS) return undefined;   // a broker full of noise cannot grow the log without limit
      entry = { topic: key, accepted: 0, rejected: 0, ignored_fields: [], last_ok_at: null, last_error: null, last_error_at: null, last_payload: null };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  ok(topic: string, ignored: readonly string[] = []): void {
    const entry = this.#entry(topic);
    if (!entry) return;
    entry.accepted += 1;
    entry.last_ok_at = new Date(this.#now()).toISOString();
    for (const name of ignored) if (!entry.ignored_fields.includes(name) && entry.ignored_fields.length < MAX_IGNORED) entry.ignored_fields.push(clip(name, 60));
  }

  rejected(topic: string, error: string, payload: string | Buffer): void {
    const entry = this.#entry(topic);
    if (!entry) return;
    entry.rejected += 1;
    entry.last_error = clip(error, 200);
    entry.last_error_at = new Date(this.#now()).toISOString();
    entry.last_payload = clip(typeof payload === "string" ? payload : payload.toString("utf8"), EXCERPT);
  }

  list(): IngestEntry[] { return [...this.#entries.values()].sort((a, b) => a.topic.localeCompare(b.topic)); }
}
