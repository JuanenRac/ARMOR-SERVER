/**
 * The sound of an alarm for the wall panel (see ../alarm_audio.ts). Two things, each behind its own switch in the security options of Studio (both off by default):
 *
 *   alarm_audio.spoken        GET /api/v1/alarm-audio/spoken?language=&source=&severity=&code=   the sentence that says the alarm out loud, made by the voice gateway and kept in a cache
 *   alarm_audio.custom_sounds GET /api/v1/alarm-audio/sounds/:source                              the sound an administrator uploaded for an origin
 *                             PUT /api/v1/alarm-audio/sounds/:source                              (administrator) a 16 kHz 16-bit mono WAVE file, checked and reduced to its samples
 *                             DELETE /api/v1/alarm-audio/sounds/:source                           (administrator) takes it away; allowed with the switch off as well
 *
 * Both reads answer raw 16 kHz 16-bit mono PCM (`audio/L16;rate=16000`) with its SHA-256 in `X-Armor-Audio-Sha256` (and as the ETag), so the panel checks what it got before it plays it.
 * GET /api/v1/alarm-audio tells Studio what is on and what is stored.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { ALARM_CODE, ALARM_SOURCES, alarmSentence, AlarmAudioError, isAlarmSeverity, isAlarmSource, isSpokenLanguage, MIN_SOUND_BYTES, samplesOfWave, sha256Of, type AlarmSource } from "../alarm_audio.js";
import { speakVoice, VoiceError } from "../voice.js";

export function registerAlarmAudioRoutes(app: Express, context: AppContext): void {
  const { config, securitySettings, alarmSounds, spokenAlarms, audit, requireOperator, requireAdmin, studioUser } = context;
  const readLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
  const writeLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  const actor = (request: Request): string => studioUser(request)?.username ?? "administrator";

  /** The samples with their hash; a panel that already holds exactly these (If-None-Match) is told so and nothing is sent. */
  const sendAudio = (request: Request, response: Response, samples: Buffer): void => {
    const digest = sha256Of(samples);
    if (String(request.headers["if-none-match"] ?? "").split(",").some(tag => tag.trim().replace(/^W\//, "") === `"${digest}"`)) { response.set({ ETag: `"${digest}"`, "X-Armor-Audio-Sha256": digest }); response.status(304).end(); return; }
    response.set({ "Content-Type": "audio/L16;rate=16000", "X-Armor-Audio-Sha256": digest, ETag: `"${digest}"`, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" });
    response.status(200).send(samples);
  };

  app.get("/api/v1/alarm-audio", requireOperator, (_request, response) => {
    response.json({
      spoken: { enabled: securitySettings.get("alarm_audio.spoken"), available: config.voice !== null },
      custom: { enabled: securitySettings.get("alarm_audio.custom_sounds"), max_bytes: config.alarmSoundMaxBytes, min_bytes: MIN_SOUND_BYTES, sources: ALARM_SOURCES, sounds: alarmSounds.list() },
    });
  });

  app.get("/api/v1/alarm-audio/spoken", requireOperator, readLimit, async (request, response) => {
    if (!securitySettings.get("alarm_audio.spoken")) return response.status(404).json({ error: "spoken_alarms_disabled" });
    const { language, source, severity, code } = request.query;
    if (!isSpokenLanguage(language)) return response.status(422).json({ error: "invalid_language" });
    if (!isAlarmSource(source)) return response.status(422).json({ error: "invalid_source" });
    if (!isAlarmSeverity(severity)) return response.status(422).json({ error: "invalid_severity" });
    if (code !== undefined && (typeof code !== "string" || !ALARM_CODE.test(code))) return response.status(422).json({ error: "invalid_code" });
    if (!config.voice) return response.status(503).json({ error: "voice_unavailable" });
    const key = `${language}|${source}|${severity}|${code ?? ""}`;
    let samples = spokenAlarms.get(key);
    if (!samples) {
      try {
        samples = await speakVoice(config.voice, { text: alarmSentence(language, source, severity, code), language }, securitySettings.get("voice.reply_audio_max_bytes"));
        spokenAlarms.set(key, samples);
      } catch (error) {
        if (error instanceof VoiceError) return response.status(error.status).json({ error: error.code });
        return response.status(500).json({ error: "internal error" });
      }
    }
    sendAudio(request, response, samples);
  });

  const sourceOf = (request: Request, response: Response): AlarmSource | undefined => {
    const source = request.params.source;
    if (isAlarmSource(source)) return source;
    response.status(404).json({ error: "unknown_source" });
    return undefined;
  };

  app.get("/api/v1/alarm-audio/sounds/:source", requireOperator, readLimit, (request, response) => {
    if (!securitySettings.get("alarm_audio.custom_sounds")) return response.status(404).json({ error: "custom_sounds_disabled" });
    const source = sourceOf(request, response);
    if (!source) return;
    const found = alarmSounds.get(source);
    if (!found) return response.status(404).json({ error: "no_sound" });
    sendAudio(request, response, found.samples);
  });

  // The body is the WAVE file as it is (any content type): a little more than the most samples allowed, for the header.
  const readSound = (request: Request, response: Response, next: express.NextFunction) => {
    express.raw({ type: () => true, limit: config.alarmSoundMaxBytes + 4_096 })(request, response, (error?: unknown) => {
      if (!error) return next();
      return response.status((error as { status?: number }).status === 413 ? 413 : 400).json({ error: (error as { status?: number }).status === 413 ? "sound_too_long" : "bad_body" });
    });
  };
  app.put("/api/v1/alarm-audio/sounds/:source", requireAdmin, context.requireElevated, writeLimit, readSound, (request, response) => {
    const source = sourceOf(request, response);
    if (!source) return;
    if (!securitySettings.get("alarm_audio.custom_sounds")) return response.status(409).json({ error: "custom_sounds_disabled" });
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return response.status(411).json({ error: "no_sound" });
    try {
      const samples = samplesOfWave(request.body, config.alarmSoundMaxBytes);
      const stored = alarmSounds.put(source, samples, actor(request), new Date());
      audit.record({ action: "alarm_audio.upload", outcome: "allowed", actor: actor(request), target: source, detail: `${stored.bytes} bytes ${stored.sha256.slice(0, 12)}` });
      return response.status(200).json(stored);
    } catch (error) {
      if (error instanceof AlarmAudioError) { audit.record({ action: "alarm_audio.upload", outcome: "denied", actor: actor(request), target: source, detail: error.code }); return response.status(error.status).json({ error: error.code }); }
      return response.status(500).json({ error: "internal error" });
    }
  });

  app.delete("/api/v1/alarm-audio/sounds/:source", requireAdmin, context.requireElevated, writeLimit, (request, response) => {
    const source = sourceOf(request, response);
    if (!source) return;
    const had = alarmSounds.remove(source);
    audit.record({ action: "alarm_audio.delete", outcome: "allowed", actor: actor(request), target: source });
    return response.status(had ? 200 : 404).json(had ? { removed: true } : { error: "no_sound" });
  });
}
