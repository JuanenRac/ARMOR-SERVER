/**
 * The sound of an alarm for the wall panel, made on this side: the sentence that says an alarm out loud (origin, how serious it is and what it is, in the language of the installation)
 * and the short sounds an administrator uploads for an origin. The panel asks for either one when an alarm of that origin arrives and plays it; if it cannot get it, it plays its own tone.
 *
 *  - The sentence is never free text: it is put together from closed lists (the origin, the severity and the alarm code, whose words are the table of alarm_codes.ts), so nothing a
 *    person or a device typed reaches the speech engine, and the number of different sentences is finite (so they are cached).
 *  - A sound is a 16 kHz, 16-bit, mono PCM WAVE file, nothing else: it is parsed here byte by byte, only its samples are kept (the file itself is thrown away), its size and its duration
 *    are limited, and a silent one is refused. What is stored is raw samples, never something that could be run.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { alarmCodeWords } from "./alarm_codes.js";
import { durableRename } from "./durable.js";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./voice.js";

/** The origins of an alarm, as the panel names them (`source_type` of the alarm; anything else is "other"). */
export const ALARM_SOURCES = ["device", "solar", "electrical", "network", "alarm", "other"] as const;
export type AlarmSource = (typeof ALARM_SOURCES)[number];
export const isAlarmSource = (value: unknown): value is AlarmSource => (ALARM_SOURCES as readonly unknown[]).includes(value);

export const ALARM_SEVERITIES = ["critical", "high", "warning", "info"] as const;
export type AlarmSeverityName = (typeof ALARM_SEVERITIES)[number];
export const isAlarmSeverity = (value: unknown): value is AlarmSeverityName => (ALARM_SEVERITIES as readonly unknown[]).includes(value);

/** The alarm codes the server uses are lower-case words with digits and a few separators; anything else is not asked about. */
export const ALARM_CODE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

type Sentence = { severity: Record<AlarmSeverityName, string>; source: Record<AlarmSource, string> };
const SENTENCE: Record<VoiceLanguage, Sentence> = {
  en: { severity: { critical: "Critical alarm", high: "High alarm", warning: "Warning", info: "Notice" }, source: { device: "Device", solar: "Solar", electrical: "Electrical", network: "Network", alarm: "Alarm panel", other: "System" } },
  es: { severity: { critical: "Alarma crítica", high: "Alarma alta", warning: "Aviso", info: "Información" }, source: { device: "Dispositivo", solar: "Solar", electrical: "Eléctrico", network: "Red", alarm: "Panel de alarma", other: "Sistema" } },
  de: { severity: { critical: "Kritischer Alarm", high: "Hoher Alarm", warning: "Warnung", info: "Hinweis" }, source: { device: "Gerät", solar: "Solar", electrical: "Elektrik", network: "Netzwerk", alarm: "Alarmzentrale", other: "System" } },
  fr: { severity: { critical: "Alarme critique", high: "Alarme élevée", warning: "Avertissement", info: "Information" }, source: { device: "Appareil", solar: "Solaire", electrical: "Électrique", network: "Réseau", alarm: "Centrale d'alarme", other: "Système" } },
  it: { severity: { critical: "Allarme critico", high: "Allarme alto", warning: "Avviso", info: "Informazione" }, source: { device: "Dispositivo", solar: "Solare", electrical: "Elettrico", network: "Rete", alarm: "Centrale di allarme", other: "Sistema" } },
  ja: { severity: { critical: "重大アラーム", high: "高レベルアラーム", warning: "警告", info: "お知らせ" }, source: { device: "デバイス", solar: "ソーラー", electrical: "電気", network: "ネットワーク", alarm: "警報パネル", other: "システム" } },
  zh: { severity: { critical: "严重报警", high: "高级报警", warning: "警告", info: "提示" }, source: { device: "设备", solar: "太阳能", electrical: "电气", network: "网络", alarm: "报警面板", other: "系统" } },
  pt: { severity: { critical: "Alarme crítico", high: "Alarme alto", warning: "Aviso", info: "Informação" }, source: { device: "Dispositivo", solar: "Solar", electrical: "Elétrico", network: "Rede", alarm: "Painel de alarme", other: "Sistema" } },
};

/** What is said for an alarm: how serious, where from and, if the code is one the server knows, what it is. An unknown code is not read out (it means nothing to a person). */
export function alarmSentence(language: VoiceLanguage, source: AlarmSource, severity: AlarmSeverityName, code?: string): string {
  const words = SENTENCE[language];
  const known = code !== undefined && ALARM_CODE.test(code) ? alarmCodeWords(code, language) : code;
  const what = known !== undefined && known !== code ? known : "";
  return [words.severity[severity], words.source[source], what].filter(Boolean).join(". ") + ".";
}

export const SAMPLE_RATE = 16_000;
export const MIN_SOUND_BYTES = 3_200;          // a tenth of a second
export const DEFAULT_SOUND_MAX_BYTES = 128_000;   // four seconds
export const SOUND_MAX_BYTES_CEILING = 256_000;   // eight seconds, whatever the environment says
/** The loudest sample a sound must reach to count as sound at all (a file of silence is a mistake, and a panel that "plays" it would seem to be broken). */
const MIN_PEAK = 64;
const MAX_CHUNKS = 16;

export class AlarmAudioError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** The samples of a WAVE file, if it is exactly 16 kHz, 16-bit, mono PCM and not too long, too short or silent; AlarmAudioError otherwise. Nothing but the samples is kept. */
export function samplesOfWave(file: Buffer, maxBytes: number): Buffer {
  if (file.length < 44) throw new AlarmAudioError(415, "not_a_wave_file");
  if (file.toString("latin1", 0, 4) !== "RIFF" || file.toString("latin1", 8, 12) !== "WAVE") throw new AlarmAudioError(415, "not_a_wave_file");
  if (file.readUInt32LE(4) + 8 > file.length) throw new AlarmAudioError(415, "wave_truncated");
  let format = false, position = 12, chunks = 0;
  while (position + 8 <= file.length) {
    if (++chunks > MAX_CHUNKS) throw new AlarmAudioError(415, "wave_unreadable");
    const name = file.toString("latin1", position, position + 4), size = file.readUInt32LE(position + 4), body = position + 8;
    if (name === "fmt ") {
      if (size < 16 || body + 16 > file.length) throw new AlarmAudioError(415, "wave_unreadable");
      const code = file.readUInt16LE(body), channels = file.readUInt16LE(body + 2), rate = file.readUInt32LE(body + 4), bits = file.readUInt16LE(body + 14);
      if (code !== 1 || channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) throw new AlarmAudioError(415, "unsupported_wave_format");
      format = true;
    } else if (name === "data") {
      if (!format) throw new AlarmAudioError(415, "wave_unreadable");
      if (size > maxBytes) throw new AlarmAudioError(413, "sound_too_long");
      if (body + size > file.length) throw new AlarmAudioError(415, "wave_truncated");
      if (size < MIN_SOUND_BYTES || size % 2 !== 0) throw new AlarmAudioError(422, "sound_too_short");
      const samples = Buffer.from(file.subarray(body, body + size));
      let peak = 0;
      for (let at = 0; at < samples.length; at += 2) peak = Math.max(peak, Math.abs(samples.readInt16LE(at)));
      if (peak < MIN_PEAK) throw new AlarmAudioError(422, "sound_is_silent");
      return samples;
    }
    position = body + size + (size & 1);
  }
  throw new AlarmAudioError(415, "wave_unreadable");
}

export const sha256Of = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
export const durationMs = (bytes: number): number => Math.round((bytes / 2) * 1000 / SAMPLE_RATE);

export type StoredSound = { source: AlarmSource; bytes: number; duration_ms: number; sha256: string; uploaded_at: string; uploaded_by: string };

/** The sounds an administrator uploaded: one per origin, kept as raw samples in `<dir>/<origin>.pcm` with the facts about it in `<dir>/<origin>.json`. */
export class SoundLibrary {
  readonly #dir: string;
  constructor(dir: string) { this.#dir = dir; }

  #files(source: AlarmSource): { pcm: string; meta: string } { return { pcm: path.join(this.#dir, `${source}.pcm`), meta: path.join(this.#dir, `${source}.json`) }; }

  put(source: AlarmSource, samples: Buffer, by: string, now: Date): StoredSound {
    const stored: StoredSound = { source, bytes: samples.length, duration_ms: durationMs(samples.length), sha256: sha256Of(samples), uploaded_at: now.toISOString(), uploaded_by: by.slice(0, 64) };
    fs.mkdirSync(this.#dir, { recursive: true });
    const files = this.#files(source);
    fs.writeFileSync(`${files.pcm}.tmp`, samples, { mode: 0o600 });
    durableRename(`${files.pcm}.tmp`, files.pcm);
    fs.writeFileSync(`${files.meta}.tmp`, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
    durableRename(`${files.meta}.tmp`, files.meta);
    return stored;
  }

  /** The samples and facts of the sound of an origin; a file that does not match its facts (damaged, or changed by hand) is not served. */
  get(source: AlarmSource): { samples: Buffer; info: StoredSound } | undefined {
    const files = this.#files(source);
    try {
      const info = JSON.parse(fs.readFileSync(files.meta, "utf8")) as StoredSound;
      const samples = fs.readFileSync(files.pcm);
      if (samples.length !== info.bytes || samples.length % 2 !== 0 || sha256Of(samples) !== info.sha256) return undefined;
      return { samples, info: { ...info, source } };
    } catch { return undefined; }
  }

  list(): StoredSound[] { return ALARM_SOURCES.flatMap(source => { const found = this.get(source); return found ? [found.info] : []; }); }

  remove(source: AlarmSource): boolean {
    const files = this.#files(source);
    const had = fs.existsSync(files.pcm) || fs.existsSync(files.meta);
    fs.rmSync(files.pcm, { force: true });
    fs.rmSync(files.meta, { force: true });
    return had;
  }
}

/** The spoken sentences already made, kept in memory: the same alarm is announced again and again, and the speech engine takes seconds. The oldest go first when the cache is full. */
export class SpokenCache {
  readonly #items = new Map<string, Buffer>();
  #bytes = 0;
  constructor(private readonly maxEntries = 64, private readonly maxBytes = 8_000_000) {}
  get(key: string): Buffer | undefined {
    const found = this.#items.get(key);
    if (found) { this.#items.delete(key); this.#items.set(key, found); }   // the most recently used last
    return found;
  }
  set(key: string, audio: Buffer): void {
    const old = this.#items.get(key);
    if (old) { this.#bytes -= old.length; this.#items.delete(key); }
    if (audio.length > this.maxBytes) return;
    this.#items.set(key, audio);
    this.#bytes += audio.length;
    while (this.#items.size > this.maxEntries || this.#bytes > this.maxBytes) {
      const oldest = this.#items.keys().next().value as string;
      this.#bytes -= this.#items.get(oldest)!.length;
      this.#items.delete(oldest);
    }
  }
  clear(): void { this.#items.clear(); this.#bytes = 0; }
  get size(): number { return this.#items.size; }
  get bytes(): number { return this.#bytes; }
}

export const isSpokenLanguage = (value: unknown): value is VoiceLanguage => (VOICE_LANGUAGES as readonly unknown[]).includes(value);
