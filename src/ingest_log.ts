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

/** Told about every message the log counts, with what was sent: the optional recorder of the traffic (ingest_recorder.ts) hangs here. */
export type IngestTap = (topic: string, payload: string | Buffer | undefined, accepted: boolean, reason?: string) => void;

const NODE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * The topic on the broker that carries the same message as an HTTP route of the nodes (the count keeps the name "http:alarm/x"; the copy for the simulator needs the topic it plays).
 * A refused message names its node only inside the body, so the node is read from there; a body without a plain node name is not copied.
 */
export function brokerTopicOf(topic: string, payload: string | Buffer): string | undefined {
  if (!topic.startsWith("http:")) return topic;
  const [kind, ...rest] = topic.slice(5).split("/");
  if (kind !== "alarm" && kind !== "electrical" && kind !== "solar" && kind !== "network" && kind !== "health") return undefined;
  let node: string | undefined = rest[0], device: string | undefined = rest[1];
  if (!node) {
    try {
      const body = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8")) as { node_id?: unknown; device?: unknown } | null;
      node = typeof body?.node_id === "string" ? body.node_id : undefined;
      device = typeof body?.device === "string" ? body.device : undefined;
    } catch { return undefined; }
  }
  if (!node || !NODE_NAME.test(node)) return undefined;
  if (kind === "health") return `armor/health/${node}`;
  if (kind === "solar") return device && NODE_NAME.test(device) ? `armor/solar/${node}/${device}/state` : undefined;
  return `armor/${kind}/${node}/state`;
}

export class IngestLog {
  /** Set once by the context; it must never throw into the ingest. */
  tap: IngestTap | undefined;
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

  ok(topic: string, ignored: readonly string[] = [], payload?: string | Buffer): void {
    this.#tell(topic, payload, true);
    const entry = this.#entry(topic);
    if (!entry) return;
    entry.accepted += 1;
    entry.last_ok_at = new Date(this.#now()).toISOString();
    for (const name of ignored) if (!entry.ignored_fields.includes(name) && entry.ignored_fields.length < MAX_IGNORED) entry.ignored_fields.push(clip(name, 60));
  }

  rejected(topic: string, error: string, payload: string | Buffer): void {
    this.#tell(topic, payload, false, error);
    const entry = this.#entry(topic);
    if (!entry) return;
    entry.rejected += 1;
    entry.last_error = clip(error, 200);
    entry.last_error_at = new Date(this.#now()).toISOString();
    entry.last_payload = clip(typeof payload === "string" ? payload : payload.toString("utf8"), EXCERPT);
  }

  #tell(topic: string, payload: string | Buffer | undefined, accepted: boolean, reason?: string): void {
    if (!this.tap || payload === undefined) return;
    const played = brokerTopicOf(topic, payload);
    if (!played) return;
    try { this.tap(played, payload, accepted, reason); } catch { /* a copy that fails is never a reason to lose the message */ }
  }

  /** Hands a message to the tap without counting it (the HTTP routes that keep no count per topic). */
  copy(topic: string, payload: unknown, accepted: boolean, reason?: string): void {
    if (!this.tap) return;
    try { this.tap(topic, typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload ?? null), accepted, reason); } catch { /* as above */ }
  }

  list(): IngestEntry[] { return [...this.#entries.values()].sort((a, b) => a.topic.localeCompare(b.topic)); }
}
