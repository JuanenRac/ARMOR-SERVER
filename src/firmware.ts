/**
 * Updating the firmware of field nodes from Studio, without opening the page of each node. The server does the work: it holds the image (a file the administrator
 * uploaded, or the newest release of the node's repository on GitHub, downloaded here and checked against the SHA-256 the release publishes) and sends it, one node at
 * a time, to the node's own update route with the node's own administrator login - used for the job and never kept or written anywhere - then waits for the node to come
 * back with the new version. So it works for every kind of node, also one with no route to the Internet.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import crypto from "node:crypto";

export type NodeKind = "radar" | "solar" | "electrical" | "alarm" | "hmi";
export const NODE_KINDS: readonly NodeKind[] = ["radar", "solar", "electrical", "alarm", "hmi"];

/**
 * The repository whose releases carry each kind's image, and the file of the release that is that image (next to it: the same name with `.sha256`). A release carries one image per
 * board, `armor_<kind>-<board>.bin`; one from before that naming has only `armor_<kind>.bin`, the image of the kind's default board (see DEFAULT_BOARDS).
 */
export const RELEASE_SOURCES: Record<NodeKind, { repo: string; asset: string }> = {
  radar: { repo: "JuanenRac/ARMOR-RADAR", asset: "armor_radar.bin" },
  solar: { repo: "JuanenRac/ARMOR-SOLAR", asset: "armor_solar.bin" },
  electrical: { repo: "JuanenRac/ARMOR-ELECTRICAL", asset: "armor_electrical.bin" },
  alarm: { repo: "JuanenRac/ARMOR-ALARM", asset: "armor_alarm.bin" },
  hmi: { repo: "JuanenRac/ARMOR-HMI", asset: "armor_hmi.bin" },
};
/** The board whose image carries the plain name in a release that predates the board in the name. */
export const DEFAULT_BOARDS: Record<NodeKind, string> = { radar: "s3-eth", solar: "s3-eth", electrical: "s3-eth", alarm: "s3-eth", hmi: "lcd7box" };

/** The files of a release that are the image for `board` and its checksum: the one built for the board; the plain name only for the kind's default board (or when the board is not known). */
export function imageNames(kind: NodeKind, board?: string): { image: string[] } {
  const plain = RELEASE_SOURCES[kind].asset, stem = plain.replace(/\.bin$/, "");
  if (!board) return { image: [plain] };
  return { image: board === DEFAULT_BOARDS[kind] ? [`${stem}-${board}.bin`, plain] : [`${stem}-${board}.bin`] };
}

export const MIN_IMAGE_BYTES = 100 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOADS = 6;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 20;
const MAX_TARGETS = 20;

export type TargetState = "waiting" | "checking" | "signing_in" | "uploading" | "restarting" | "done" | "failed";
/** `progress` is 0-100 for this node (the steps weigh what they take: the picture goes from 15 to 80, the restart from 80 to 98), `sent` and `total` are bytes of the picture, `waited_s` the seconds since the node was told to restart. */
export type JobTarget = { address: string; node_id?: string; state: TargetState; version_before?: string; version_after?: string; error?: string; progress?: number; sent?: number; total?: number; waited_s?: number };
export type FirmwareJob = {
  id: string; kind: NodeKind; source: "github" | "upload"; state: "preparing" | "running" | "done" | "failed";
  version?: string; bytes?: number; sha256?: string; error?: string; targets: JobTarget[]; started: number; finished?: number;
};
export type UploadInfo = { id: string; name: string; bytes: number; sha256: string };
export type ReleaseInfo = { kind: NodeKind; repo: string; version: string; bytes: number; checksum: boolean };

export class FirmwareError extends Error {
  constructor(readonly code: string) { super(code); }
}

type Image = { bytes: Buffer; sha256: string; version?: string };

export type FirmwareOptions = {
  now?: () => number;
  /** The port of a node's panel: 80, except in tests. */
  nodePort?: () => number;
  /** Where releases are read from (GitHub's API); a test points it at a stand-in. */
  releaseApi?: () => string;
  /** How long to wait for a node to come back, and how often to ask it (milliseconds). */
  restartWaitMs?: number;
  pollMs?: number;
  /** How long the node is given before it is asked whether it is back (it restarts a moment after it has answered). */
  settleMs?: number;
};

const sha256Of = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The 64 hex digits at the start of a `sha256sum` line (a bare hash also works), in lowercase; undefined when the text does not start with one. */
export function parseChecksum(text: string): string | undefined {
  const match = /^\s*([0-9a-fA-F]{64})(?![0-9a-fA-F])/.exec(text);
  return match ? match[1].toLowerCase() : undefined;
}

/** How far a node is, 0-100: the quick steps count a little, sending the picture most of it, and the restart fills the end. */
function progressOf(target: JobTarget): number {
  switch (target.state) {
    case "waiting": return 0;
    case "checking": return 5;
    case "signing_in": return 12;
    case "uploading": return 15 + 65 * (target.total ? Math.min(1, (target.sent ?? 0) / target.total) : 0);
    case "restarting": return 80 + Math.min(18, target.waited_s ?? 0);
    default: return target.progress ?? 0;
  }
}

export class FirmwareService {
  readonly #uploads = new Map<string, { info: UploadInfo; image: Image; at: number }>();
  readonly #jobs = new Map<string, FirmwareJob>();
  readonly #now: () => number;
  readonly #nodePort: () => number;
  readonly #releaseApi: () => string;
  readonly #restartWaitMs: number;
  readonly #pollMs: number;
  readonly #settleMs: number;
  #running = false;
  readonly #restartedAt = new WeakMap<JobTarget, number>();

  constructor(options: FirmwareOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#nodePort = options.nodePort ?? (() => 0);
    this.#releaseApi = options.releaseApi ?? (() => "https://api.github.com");
    this.#restartWaitMs = options.restartWaitMs ?? 120_000;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#settleMs = options.settleMs ?? 4_000;
  }

  // ---- the images -------------------------------------------------------------------------------------------------------------------

  /** Keeps an uploaded image for a job. Only what looks like an ESP32 application image of a sensible size is kept. */
  addUpload(bytes: Buffer, name: string): UploadInfo {
    if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) throw new FirmwareError("bad_size");
    if (bytes[0] !== 0xe9) throw new FirmwareError("not_firmware");   // the magic byte of an ESP32 image
    this.#expireUploads();
    while (this.#uploads.size >= MAX_UPLOADS) this.#uploads.delete(this.#uploads.keys().next().value as string);
    const sha256 = sha256Of(bytes);
    const info: UploadInfo = { id: crypto.randomUUID(), name: name.replace(/[^\w.-]/g, "_").slice(0, 80) || "firmware.bin", bytes: bytes.length, sha256 };
    this.#uploads.set(info.id, { info, image: { bytes, sha256 }, at: this.#now() });
    return info;
  }

  #expireUploads(): void {
    for (const [id, item] of this.#uploads) if (this.#now() - item.at > UPLOAD_TTL_MS) this.#uploads.delete(id);
  }

  async #get(url: string, accept?: string): Promise<Response> {
    return fetch(url, { headers: { "User-Agent": "ARMOR-SERVER", ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(30_000) });
  }

  /** The newest release of the repository of this kind of node: its image, downloaded and checked against the hash the release publishes. A release without that hash is refused. */
  async fetchRelease(kind: NodeKind, board?: string): Promise<Image & { version: string }> {
    const source = RELEASE_SOURCES[kind];
    const meta = await this.#get(`${this.#releaseApi()}/repos/${source.repo}/releases/latest`, "application/vnd.github+json").catch(() => undefined);
    if (!meta) throw new FirmwareError("github_unreachable");
    if (meta.status === 404) throw new FirmwareError("no_release");
    if (!meta.ok) throw new FirmwareError(`github_http_${meta.status}`);
    const release = await meta.json() as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
    const version = String(release.tag_name ?? "").replace(/^v/, "");
    // the image built for the node's board first, then (only for the default board) the plain name; the checksum is the one next to the image that was taken
    let name: string | undefined;
    for (const wanted of imageNames(kind, board).image) if (!name && release.assets?.some(item => item.name === wanted)) name = wanted;
    const asset = name ? release.assets?.find(item => item.name === name)?.browser_download_url : undefined;
    const checksum = name ? release.assets?.find(item => item.name === `${name}.sha256`)?.browser_download_url : undefined;
    if (!version || !asset) throw new FirmwareError(board && board !== DEFAULT_BOARDS[kind] ? "no_image_for_board" : "no_image_in_release");
    if (!checksum) throw new FirmwareError("no_checksum");
    const [imageReply, checksumReply] = await Promise.all([this.#get(asset).catch(() => undefined), this.#get(checksum).catch(() => undefined)]);
    if (!imageReply?.ok || !checksumReply?.ok) throw new FirmwareError("download_failed");
    const expected = parseChecksum(await checksumReply.text());
    if (!expected) throw new FirmwareError("no_checksum");
    const declared = Number(imageReply.headers.get("content-length") ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new FirmwareError("bad_size");
    const bytes = Buffer.from(await imageReply.arrayBuffer());
    if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) throw new FirmwareError("bad_size");
    if (sha256Of(bytes) !== expected) throw new FirmwareError("checksum_mismatch");
    return { bytes, sha256: expected, version };
  }

  /** What the newest release of a kind of node is (it is downloaded and checked, which is how it is known to be usable). */
  async releaseInfo(kind: NodeKind): Promise<ReleaseInfo> {
    const image = await this.fetchRelease(kind);
    return { kind, repo: RELEASE_SOURCES[kind].repo, version: image.version, bytes: image.bytes.length, checksum: true };
  }

  // ---- the nodes --------------------------------------------------------------------------------------------------------------------

  #base(address: string): string {
    const port = this.#nodePort();
    return `http://${address}${port > 0 ? `:${port}` : ""}`;
  }

  /** What a node says about itself without a login: its id, its version, its board and, from the firmware that says it, its kind (radar, solar, electrical, hmi). */
  async probe(address: string): Promise<{ address: string; reachable: boolean; node_id?: string; version?: string; board?: string; kind?: string }> {
    try {
      const reply = await fetch(`${this.#base(address)}/api/v1/session`, { signal: AbortSignal.timeout(4_000) });
      if (!reply.ok) return { address, reachable: false };
      const data = await reply.json() as { node_id?: string; version?: string; board?: string; kind?: string };
      return { address, reachable: true, node_id: data.node_id, version: data.version, board: data.board, ...(typeof data.kind === "string" ? { kind: data.kind } : {}) };
    } catch { return { address, reachable: false }; }
  }

  async #updateNode(target: JobTarget, image: Image, login: { user: string; password: string }): Promise<void> {
    const base = this.#base(target.address);
    const set = (state: TargetState) => { target.state = state; };
    set("checking");
    const before = await this.probe(target.address);
    if (!before.reachable) throw new FirmwareError("node_not_reachable");
    target.node_id = before.node_id; target.version_before = before.version;

    set("signing_in");
    const signIn = await fetch(`${base}/api/v1/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(login), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    const cookie = signIn?.headers.get("set-cookie")?.split(";")[0];
    if (!signIn) throw new FirmwareError("node_not_reachable");
    if (signIn.status === 401) throw new FirmwareError("panel_login_refused");
    if (!signIn.ok || !cookie) throw new FirmwareError("panel_login_failed");

    set("uploading");
    // The image goes as a stream that counts what has been taken, so the console can show how far it is (a node needs the length: it does not read chunked bodies).
    const total = image.bytes.length;
    let offset = 0;
    target.total = total; target.sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= total) { controller.close(); return; }
        const end = Math.min(offset + 16_384, total);
        controller.enqueue(new Uint8Array(image.bytes.subarray(offset, end)));
        offset = end; target.sent = offset;
      },
    });
    const sent = await fetch(`${base}/api/v1/ota`, {
      method: "POST", headers: { Cookie: cookie, "X-Requested-With": "armor", "Content-Type": "application/octet-stream", "Content-Length": String(total) },
      body: stream, duplex: "half", signal: AbortSignal.timeout(240_000),
    } as RequestInit & { duplex: "half" }).catch(() => undefined);
    if (!sent) throw new FirmwareError("upload_failed");
    const answer = await sent.json().catch(() => ({})) as { error?: string; version?: string; sha256?: string };
    if (!sent.ok) throw new FirmwareError(answer.error ? `node_${answer.error}` : `node_http_${sent.status}`);
    if (answer.sha256 && answer.sha256.toLowerCase() !== image.sha256) throw new FirmwareError("hash_mismatch");

    target.sent = total;
    set("restarting");
    this.#restartedAt.set(target, this.#now());
    const expected = answer.version ?? image.version;
    await sleep(this.#settleMs);
    const deadline = this.#now() + this.#restartWaitMs;
    for (;;) {
      const state = await this.probe(target.address);
      if (state.reachable && (!expected || state.version === expected)) { target.version_after = state.version; return; }
      if (this.#now() > deadline) throw new FirmwareError("did_not_come_back");
      await sleep(this.#pollMs);
    }
  }

  // ---- the jobs ---------------------------------------------------------------------------------------------------------------------

  /** Starts a job and returns at once; the nodes are updated one at a time in the background. The login is held only by that run. */
  start(input: { kind: NodeKind; source: "github" | "upload"; uploadId?: string; targets: Array<{ address: string; node_id?: string }>; login: { user: string; password: string }; onNode?: (job: FirmwareJob, target: JobTarget) => void }): FirmwareJob {
    if (this.#running) throw new FirmwareError("job_running");
    if (input.targets.length < 1 || input.targets.length > MAX_TARGETS) throw new FirmwareError("bad_targets");
    let upload: Image | undefined;
    if (input.source === "upload") {
      this.#expireUploads();
      upload = this.#uploads.get(input.uploadId ?? "")?.image;
      if (!upload) throw new FirmwareError("unknown_upload");
    }
    const job: FirmwareJob = {
      id: crypto.randomUUID(), kind: input.kind, source: input.source, state: "preparing", started: this.#now(),
      targets: input.targets.map(target => ({ address: target.address, ...(target.node_id ? { node_id: target.node_id } : {}), state: "waiting" as TargetState })),
    };
    this.#jobs.set(job.id, job);
    while (this.#jobs.size > MAX_JOBS) this.#jobs.delete(this.#jobs.keys().next().value as string);
    this.#running = true;
    void this.#run(job, upload, input.login, input.onNode).finally(() => { this.#running = false; job.finished = this.#now(); });
    return job;
  }

  async #run(job: FirmwareJob, upload: Image | undefined, login: { user: string; password: string }, onNode?: (job: FirmwareJob, target: JobTarget) => void): Promise<void> {
    // Each node gets the image built for ITS board: a job that mixes boards (an Ethernet and a Wi-Fi node of one kind) fetches one image per board. An uploaded file is the
    // administrator's choice and goes to every node as it is.
    const images = new Map<string, Image & { version?: string }>();
    const boardOf = new Map<JobTarget, string | undefined>();
    let image: Image & { version?: string };
    try {
      if (upload) image = upload;
      else {
        await Promise.all(job.targets.map(async target => { boardOf.set(target, await this.probe(target.address).then(probe => probe.board).catch(() => undefined)); }));
        for (const board of new Set(job.targets.map(target => boardOf.get(target)))) images.set(board ?? "", await this.fetchRelease(job.kind, board));
        image = images.values().next().value as Image & { version?: string };
      }
    } catch (error) {
      job.state = "failed"; job.error = error instanceof FirmwareError ? error.code : "preparing_failed";
      for (const target of job.targets) { target.state = "failed"; target.error = job.error; }
      return;
    }
    job.version = image.version; job.bytes = image.bytes.length; job.sha256 = image.sha256; job.state = "running";
    for (const target of job.targets) {
      try { await this.#updateNode(target, upload ?? images.get(boardOf.get(target) ?? "") ?? image, login); }
      catch (error) { target.state = "failed"; target.error = error instanceof FirmwareError ? error.code : "failed"; }
      if (target.state !== "failed") target.state = "done";
      onNode?.(job, target);
    }
    job.state = job.targets.every(target => target.state === "done") ? "done" : "failed";
    if (job.state === "failed") job.error = "some_nodes_failed";
  }

  /** A job as it stands now, with the progress of every node worked out. */
  job(id: string): FirmwareJob | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    for (const target of job.targets) {
      const since = this.#restartedAt.get(target);
      if (since !== undefined) target.waited_s = Math.max(0, Math.round((this.#now() - since) / 1000));
      if (target.state === "done") target.progress = 100;
      else if (target.state === "failed") target.progress = target.progress ?? 0;
      else target.progress = Math.round(progressOf(target));
    }
    return job;
  }
}
