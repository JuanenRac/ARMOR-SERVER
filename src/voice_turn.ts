/**
 * The binary voice turn between the wall panel and this server: a `multipart/form-data` request with the audio as raw bytes (and an optional `meta` part), and the `multipart/mixed` answer with the spoken
 * reply as a part instead of base64. The rules (parts, framing, limits, errors) are ARMOR-COMMON's contract (docs/CONTRACTS.md, "Voice turn"); this reader is checked against the same byte-level
 * cases as its reference (`armor_common.voice`). It is strict on purpose: exactly the parts of the contract, each once, the headers it needs and nothing else, and the sizes checked before anything is copied.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import crypto from "node:crypto";

export const VOICE_LANGUAGES = ["en", "es", "de", "fr", "it", "ja", "zh", "pt"] as const;
export type VoiceTurnLanguage = typeof VOICE_LANGUAGES[number];
export type ReplyAudio = "base64" | "binary" | "none";
export type VoiceTurnMeta = { language: VoiceTurnLanguage; encoding: "pcm_s16le"; sample_rate: 16000; channels: 1; reply_audio?: ReplyAudio };
export type VoiceTurnResult = { heard: string; reply: string; audio?: string; audio_omitted?: "too_large" };

export const MAX_META_BYTES = 1024;
export const MAX_PART_HEADER_BYTES = 512;
export const FRAMING_OVERHEAD = 4096;
export const MAX_RESULT_BYTES = 8192;
export const MAX_TEXT_CHARS = 2000;
const REPLY_AUDIO = ["base64", "binary", "none"] as const;

/** A turn that breaks the contract: `code` is the short word the server answers with and `status` its HTTP status. */
export class VoiceTurnError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const CRLF = Buffer.from("\r\n");
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/;

const checkBoundary = (boundary: string): void => { if (!BOUNDARY.test(boundary) || boundary.endsWith(".")) throw new VoiceTurnError(400, "bad_multipart"); };

/** Whether a request is the binary voice turn (and not the older raw one). */
export const isMultipartForm = (contentType: string): boolean => contentType.split(";", 1)[0]!.trim().toLowerCase() === "multipart/form-data";

/** The boundary of a Content-Type that must be `multipart/<kind>`; `bad_multipart` for anything else. */
export function boundaryOf(contentType: string, kind: "form-data" | "mixed"): string {
  const parts = contentType.split(";").map(part => part.trim());
  if (parts[0]!.toLowerCase() !== `multipart/${kind}`) throw new VoiceTurnError(400, "bad_multipart");
  let boundary = "";
  for (const item of parts.slice(1)) {
    const at = item.indexOf("=");
    const name = (at < 0 ? item : item.slice(0, at)).trim().toLowerCase();
    if (name !== "boundary") continue;
    if (boundary) throw new VoiceTurnError(400, "bad_multipart");
    boundary = (at < 0 ? "" : item.slice(at + 1)).trim();
    if (boundary.length >= 2 && boundary.startsWith('"') && boundary.endsWith('"')) boundary = boundary.slice(1, -1);
  }
  checkBoundary(boundary);
  return boundary;
}

type Part = { name: string; contentType: string; data: Buffer };

function split(body: Buffer, boundary: string, kind: "form-data" | "mixed", allowed: readonly string[], maxBytes: Record<string, number>): Part[] {
  const opening = Buffer.from(`--${boundary}`, "latin1");
  const delimiter = Buffer.concat([CRLF, opening]);
  if (body.length < opening.length + 2 || !body.subarray(0, opening.length).equals(opening) || !body.subarray(opening.length, opening.length + 2).equals(CRLF)) throw new VoiceTurnError(400, "bad_multipart");
  let position = opening.length + 2;
  const parts: Part[] = [];
  const disposition = kind === "form-data" ? /^\s*form-data\s*;\s*name="([a-z]{1,16})"\s*(;\s*filename="[^"\r\n]{0,64}")?\s*$/ : /^\s*(?:inline|attachment)\s*;\s*name="([a-z]{1,16})"\s*$/;
  for (;;) {
    const headerEnd = body.indexOf(Buffer.concat([CRLF, CRLF]), position - 2);
    if (headerEnd < 0 || headerEnd - position > MAX_PART_HEADER_BYTES) throw new VoiceTurnError(400, "bad_multipart");
    const headerBlock = headerEnd >= position ? body.subarray(position, headerEnd) : Buffer.alloc(0);
    const dataStart = headerEnd + 4;
    const end = body.indexOf(delimiter, dataStart);
    if (end < 0) throw new VoiceTurnError(400, "bad_multipart");
    let name = "", contentType = "";
    if (headerBlock.length) {
      for (const raw of splitLines(headerBlock)) {
        for (const byte of raw) if (byte > 127) throw new VoiceTurnError(400, "bad_multipart");
        const line = raw.toString("latin1");
        const colon = line.indexOf(":");
        const key = colon < 0 ? "" : line.slice(0, colon).trim().toLowerCase();
        const value = colon < 0 ? "" : line.slice(colon + 1);
        if (colon < 0 || (key !== "content-disposition" && key !== "content-type")) throw new VoiceTurnError(400, "bad_multipart");
        if (key === "content-type") {
          if (contentType) throw new VoiceTurnError(400, "bad_multipart");
          contentType = value.trim();
        } else {
          if (name) throw new VoiceTurnError(400, "bad_multipart");
          const match = disposition.exec(value);
          if (!match) throw new VoiceTurnError(400, "bad_multipart");
          name = match[1]!;
        }
      }
    }
    if (!name) throw new VoiceTurnError(400, "bad_multipart");
    if (!allowed.includes(name)) throw new VoiceTurnError(422, "unknown_part");
    if (parts.some(part => part.name === name)) throw new VoiceTurnError(422, "duplicate_part");
    const data = body.subarray(dataStart, end);
    if (data.length > (maxBytes[name] ?? MAX_META_BYTES)) throw name === "audio" ? new VoiceTurnError(413, "audio_too_large") : new VoiceTurnError(422, "bad_meta");
    parts.push({ name, contentType, data });
    position = end + delimiter.length;
    const tail = body.subarray(position, position + 2);
    if (tail.length === 2 && tail[0] === 0x2d && tail[1] === 0x2d) {
      const rest = body.subarray(position + 2);
      if (rest.length !== 0 && !rest.equals(CRLF)) throw new VoiceTurnError(400, "bad_multipart");
      return parts;
    }
    if (!tail.equals(CRLF)) throw new VoiceTurnError(400, "bad_multipart");
    position += 2;
  }
}

function splitLines(block: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (;;) {
    const at = block.indexOf(CRLF, start);
    if (at < 0) { lines.push(block.subarray(start)); return lines; }
    lines.push(block.subarray(start, at));
    start = at + 2;
  }
}

const audioTypeOk = (contentType: string): boolean => ["audio/l16;rate=16000", "application/octet-stream"].includes(contentType.replace(/ /g, "").toLowerCase());

function readMeta(data: Buffer, contentType: string): VoiceTurnMeta {
  const fail = new VoiceTurnError(422, "bad_meta");
  if (contentType && contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") throw fail;
  let loaded: unknown;
  try { loaded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } catch { throw fail; }
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) throw fail;
  const meta = loaded as Record<string, unknown>;
  const allowed = ["language", "encoding", "sample_rate", "channels", "reply_audio"];
  if (Object.keys(meta).some(key => !allowed.includes(key))) throw fail;
  if (!(VOICE_LANGUAGES as readonly unknown[]).includes(meta.language) || meta.encoding !== "pcm_s16le" || meta.sample_rate !== 16000 || meta.channels !== 1) throw fail;
  if (meta.reply_audio !== undefined && !(REPLY_AUDIO as readonly unknown[]).includes(meta.reply_audio)) throw fail;
  return meta as VoiceTurnMeta;
}

/** The meta (null when the part is absent) and the audio of a binary voice request. Throws VoiceTurnError with the status and code of the contract. */
export function parseVoiceTurnRequest(contentType: string, body: Buffer, maxAudioBytes: number): { meta: VoiceTurnMeta | null; audio: Buffer } {
  const boundary = boundaryOf(contentType, "form-data");
  if (body.length > maxAudioBytes + MAX_META_BYTES + FRAMING_OVERHEAD) throw new VoiceTurnError(413, "audio_too_large");
  const parts = split(body, boundary, "form-data", ["meta", "audio"], { audio: maxAudioBytes, meta: MAX_META_BYTES });
  const audio = parts.find(part => part.name === "audio");
  if (!audio) throw new VoiceTurnError(422, "missing_audio");
  if (audio.contentType && !audioTypeOk(audio.contentType)) throw new VoiceTurnError(415, "unsupported_audio_type");
  if (audio.data.length === 0 || audio.data.length % 2) throw new VoiceTurnError(411, "bad audio length");
  const meta = parts.find(part => part.name === "meta");
  return { meta: meta ? readMeta(meta.data, meta.contentType) : null, audio: audio.data };
}

/** The Content-Type and the body of a binary voice request (for the tests and for a client written in TypeScript). */
export function buildVoiceTurnRequest(audio: Buffer, meta?: VoiceTurnMeta, boundary = newBoundary()): { contentType: string; body: Buffer } {
  checkBoundary(boundary);
  const marker = Buffer.from(`--${boundary}`);
  if (audio.includes(marker)) throw new VoiceTurnError(400, "bad_multipart");
  const chunks: Buffer[] = [];
  const add = (...lines: Array<string | Buffer>): void => { for (const line of lines) chunks.push(Buffer.isBuffer(line) ? line : Buffer.from(line), CRLF); };
  if (meta) add(marker, 'Content-Disposition: form-data; name="meta"', "Content-Type: application/json", "", JSON.stringify(meta));
  add(marker, 'Content-Disposition: form-data; name="audio"', "Content-Type: audio/L16;rate=16000", "", audio);
  chunks.push(Buffer.from(`--${boundary}--`), CRLF);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/** The Content-Type and the body of the `multipart/mixed` answer: the JSON `result` (without an `audio` field) and, when there is one, the `audio` part. */
export function buildVoiceTurnReply(result: VoiceTurnResult, audio?: Buffer, boundary = newBoundary()): { contentType: string; body: Buffer } {
  if (result.audio !== undefined) throw new VoiceTurnError(400, "bad_multipart");
  checkBoundary(boundary);
  const marker = Buffer.from(`--${boundary}`);
  if (audio?.includes(marker)) throw new VoiceTurnError(400, "bad_multipart");
  const chunks: Buffer[] = [];
  const add = (...lines: Array<string | Buffer>): void => { for (const line of lines) chunks.push(Buffer.isBuffer(line) ? line : Buffer.from(line), CRLF); };
  add(marker, 'Content-Disposition: inline; name="result"', "Content-Type: application/json", "", JSON.stringify(result));
  if (audio && audio.length) add(marker, 'Content-Disposition: inline; name="audio"', "Content-Type: audio/L16;rate=16000", "", audio);
  chunks.push(Buffer.from(`--${boundary}--`), CRLF);
  return { contentType: `multipart/mixed; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/** The result and the audio (null when the answer is text only) of a binary answer. */
export function parseVoiceTurnReply(contentType: string, body: Buffer, maxAudioBytes: number): { result: VoiceTurnResult; audio: Buffer | null } {
  const boundary = boundaryOf(contentType, "mixed");
  const parts = split(body, boundary, "mixed", ["result", "audio"], { audio: maxAudioBytes, result: MAX_RESULT_BYTES });
  const part = parts.find(item => item.name === "result");
  const fail = new VoiceTurnError(422, "bad_meta");
  if (!part) throw fail;
  let loaded: unknown;
  try { loaded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(part.data)); } catch { throw fail; }
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) throw fail;
  const result = loaded as Record<string, unknown>;
  if (Object.keys(result).some(key => key !== "heard" && key !== "reply" && key !== "audio_omitted")) throw fail;
  if (typeof result.heard !== "string" || typeof result.reply !== "string" || result.heard.length > MAX_TEXT_CHARS || result.reply.length > MAX_TEXT_CHARS) throw fail;
  if (result.audio_omitted !== undefined && result.audio_omitted !== "too_large") throw fail;
  const audio = parts.find(item => item.name === "audio")?.data ?? null;
  if (audio && (audio.length === 0 || audio.length % 2)) throw new VoiceTurnError(411, "bad audio length");
  return { result: result as VoiceTurnResult, audio };
}

function newBoundary(): string { return `armor${crypto.randomBytes(12).toString("hex")}`; }

/**
 * What the voice gateway answered (its JSON, `{heard, reply, audio?}` with base64 audio) turned into what the panel asked for. Returns null when the gateway's answer is not a voice reply
 * (the route answers 502). `reply_audio` `base64` is not handled here: that answer is the gateway's text as it is.
 */
export function shapeReply(text: string, mode: Exclude<ReplyAudio, "base64">, maxReplyAudioBytes: number): { contentType: string; body: Buffer | string } | null {
  let loaded: unknown;
  try { loaded = JSON.parse(text); } catch { return null; }
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) return null;
  const gateway = loaded as Record<string, unknown>;
  if (typeof gateway.heard !== "string" || typeof gateway.reply !== "string") return null;
  if (gateway.audio !== undefined && (typeof gateway.audio !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(gateway.audio))) return null;
  const result: VoiceTurnResult = { heard: gateway.heard.slice(0, MAX_TEXT_CHARS), reply: gateway.reply.slice(0, MAX_TEXT_CHARS) };
  let audio: Buffer | undefined;
  if (mode === "binary" && typeof gateway.audio === "string" && gateway.audio.length) {
    const bytes = Buffer.from(gateway.audio, "base64");
    if (bytes.length > maxReplyAudioBytes) result.audio_omitted = "too_large";
    else if (bytes.length % 2 === 0) audio = bytes;   // a recording of an odd number of bytes is not 16-bit PCM: the text goes alone
  }
  if (mode === "none") return { contentType: "application/json", body: JSON.stringify(result) };
  const built = buildVoiceTurnReply(result, audio);
  return { contentType: built.contentType, body: built.body };
}
