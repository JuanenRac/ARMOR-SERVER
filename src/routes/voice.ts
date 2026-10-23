/**
 * Written and spoken commands from the console and the phone: POST /api/v1/voice/command takes what the person said (as text), asks the voice gateway what it means
 * (see ../voice.ts) and carries out what was accepted - arm, disarm, say the state, silence the alarms - with the session of the person, in the audit trail. Arming and
 * disarming need a second turn: the first answers `confirmation-needed` with a token, the second repeats the phrase with it.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express, type Request } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { checkDisarm } from "./disarm_gate.js";
import { askVoice, isVoiceLanguage, spokenResult, VoiceError, type VoiceLanguage } from "../voice.js";
import { ANSWERED_HERE, carryOut } from "../voice_actions.js";
import { FRAMING_OVERHEAD, isMultipartForm, MAX_META_BYTES, parseVoiceTurnRequest, shapeReply, VoiceTurnError, type ReplyAudio } from "../voice_turn.js";
import crypto from "node:crypto";

const MAX_TEXT = 200;
/** The wall panel that spoke, as it says it in `X-Armor-Panel` (its node id): the voice gateway hands it back on the command, so that what the panel asked is written down as that panel's and a pending question is its own. */
const PANEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const panelOf = (value: unknown): string | undefined => (typeof value === "string" && PANEL.test(value) ? value : undefined);

export function registerVoiceRoutes(app: Express, context: AppContext): void {
  const { config, store, alarms, audit, requireOperator, studioUser } = context;
  /** The panel behind a command that came with the operator token of the voice gateway (a person with a session of their own is never replaced by the panel). */
  const panelBehind = (request: Request): string | undefined => (studioUser(request) ? undefined : panelOf(request.headers["x-armor-panel"]));
  const actor = (request: Request): string => studioUser(request)?.username ?? (panelBehind(request) ? `operator via ${panelBehind(request)}` : "operator");
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

  /** Whether written and spoken commands are available on this install (the phone asks before it shows the microphone). */
  app.get("/api/v1/voice/status", requireOperator, (_request, response) => response.json({ available: config.voice !== null }));

  /**
   * The wall panel speaks to the voice gateway through this server: the gateway listens on this machine only, and the panel is another device. The panel sends its audio here with the
   * voice token it was given (the same one the gateway asks for); the server passes it on, with the address of the panel so each panel has its own pending question, and gives back
   * the answer as it is. Both paths name the same thing: the second lets the panel's own setting be this server's address plus `/api/v1/voice` (it adds `/v1/turn` itself).
   *
   * Two forms of request, told apart by the Content-Type: the audio as the whole body (`audio/L16;rate=16000`, as always) or `multipart/form-data` with the audio as raw bytes and an optional
   * `meta` part (ARMOR-COMMON, "Voice turn"; allowed by the option voice.multipart_turn). The gateway is spoken to the same way in both. To the multipart one the answer may come as
   * `multipart/mixed` with the spoken reply as a part (`reply_audio` `binary`), as JSON without audio (`none`) or as the gateway's own JSON (`base64`, the default). The sizes are settings
   * of the server (voice.turn_max_bytes and voice.reply_audio_max_bytes, set in Studio; ARMOR_VOICE_TURN_MAX_BYTES and ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES are where they start).
   */
  const turnLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const maxAudio = () => context.securitySettings.get("voice.turn_max_bytes");   // read for every turn: a change in Studio counts at once
  const authorize = (request: Request, response: import("express").Response, next: import("express").NextFunction) => {
    if (!config.voice) return response.status(503).json({ error: "voice_unavailable" });
    const given = Buffer.from(String(request.headers["x-armor-voice-token"] ?? "")), wanted = Buffer.from(config.voice.token);
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) { audit.record({ action: "voice.turn", outcome: "denied" }); return response.status(401).json({ error: "unauthorized" }); }
    if (isMultipartForm(String(request.headers["content-type"] ?? "")) && !context.securitySettings.get("voice.multipart_turn")) return response.status(415).json({ error: "multipart_turn_disabled" });
    return next();
  };
  const parsers = new Map<number, ReturnType<typeof express.raw>>();
  const raw = (limit: number) => { let parser = parsers.get(limit); if (!parser) { parser = express.raw({ type: () => true, limit }); parsers.set(limit, parser); } return parser; };
  const readBody = (request: Request, response: import("express").Response, next: import("express").NextFunction) => {
    const limit = maxAudio();
    const parser = raw(isMultipartForm(String(request.headers["content-type"] ?? "")) ? limit + MAX_META_BYTES + FRAMING_OVERHEAD : limit);
    parser(request, response, (error?: unknown) => {
      if (!error) return next();
      const status = (error as { status?: number }).status;
      if (status === 413) return response.status(413).json({ error: "audio_too_large" });
      return response.status(400).json({ error: "bad_multipart" });
    });
  };
  const turn = async (request: Request, response: import("express").Response) => {
    const config_voice = config.voice!;   // authorize() has answered 503 when there is none
    try { context.connections.seen({ ...context.sightingOf(request), kind: "voice" }); } catch { /* the history never stops a turn */ }
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const contentType = String(request.headers["content-type"] ?? "");
    const multipart = isMultipartForm(contentType);
    let audio = body, language = String(request.headers["x-armor-language"] ?? "en"), replyAudio: ReplyAudio = "base64";
    if (multipart) {
      try {
        const parsed = parseVoiceTurnRequest(contentType, body, maxAudio());
        audio = parsed.audio;
        if (parsed.meta) { language = parsed.meta.language; replyAudio = parsed.meta.reply_audio ?? "base64"; }
      } catch (error) {
        if (error instanceof VoiceTurnError) { audit.record({ action: "voice.turn", outcome: "denied", detail: error.code }); return response.status(error.status).json({ error: error.code }); }
        throw error;
      }
    } else if (body.length === 0) return response.status(411).json({ error: "bad audio length" });
    try {
      const reply = await fetch(`${config_voice.url.replace(/\/$/, "")}/v1/turn`, {
        method: "POST", body: new Uint8Array(audio), signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "audio/L16;rate=16000", "X-Armor-Voice-Token": config_voice.token, "X-Armor-Language": language, "X-Armor-Client": request.ip ?? "panel", ...(panelOf(request.headers["x-armor-panel"]) ? { "X-Armor-Panel": panelOf(request.headers["x-armor-panel"])! } : {}),
          // The policy of this server for the voice service (JSON): what it asks before silencing the alarm (setting voice.silence_confirmation: off, pin or double_turn). A service that does not know it treats it as off.
          "X-Armor-Policy": JSON.stringify({ silence_confirmation: context.securitySettings.get("voice.silence_confirmation") }) },
      });
      const text = await reply.text();
      audit.record({ action: "voice.turn", outcome: reply.ok ? "allowed" : "denied", detail: `${reply.status}${multipart ? " multipart" : ""}${panelOf(request.headers["x-armor-panel"]) ? ` ${panelOf(request.headers["x-armor-panel"])}` : ""}` });
      if (multipart && reply.ok && replyAudio !== "base64") {
        const shaped = shapeReply(text, replyAudio, context.securitySettings.get("voice.reply_audio_max_bytes"));
        if (!shaped) return response.status(502).json({ error: "voice_bad_reply" });
        return response.status(200).type(shaped.contentType).send(shaped.body);
      }
      return response.status(reply.status).type("application/json").send(text.slice(0, 400_000));
    } catch { return response.status(503).json({ error: "voice_not_answering" }); }
  };
  app.post("/api/v1/voice/turn", turnLimit, authorize, readBody, turn);
  app.post("/api/v1/voice/v1/turn", turnLimit, authorize, readBody, turn);

  app.post("/api/v1/voice/command", requireOperator, limit, async (request, response) => {
    const input = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return response.status(422).json({ error: "no_text" });
    if (text.length > MAX_TEXT) return response.status(422).json({ error: "text_too_long" });
    const language: VoiceLanguage = isVoiceLanguage(input.language) ? input.language : "en";
    if (input.language !== undefined && !isVoiceLanguage(input.language)) return response.status(422).json({ error: "invalid_language" });
    const confirmation = typeof input.confirmation === "string" && input.confirmation ? input.confirmation : undefined;
    if (!config.voice) return response.status(503).json({ error: "voice_unavailable" });

    try {
      // The confirmation token the gateway issues is bound to the person who asked: another session cannot use it.
      const subject = (studioUser(request)?.id ?? (panelBehind(request) ? `panel:${panelBehind(request)}` : "operator")).slice(0, 64);
      const answer = await askVoice(config.voice, { text, language, subject, policy: { silence_confirmation: context.securitySettings.get("voice.silence_confirmation") }, ...(confirmation ? { confirmation } : {}) });
      let speech = answer.speech ?? "";
      let result: Record<string, unknown> | undefined;
      let executed = false;
      if (answer.accepted && answer.intent === "arm") {
        audit.record({ action: "control.arm", outcome: "allowed", actor: actor(request), detail: "voice" });
        store.arm("armed"); executed = true; speech = spokenResult(language, { intent: "arm" }); result = { mode: "armed" };
      } else if (answer.accepted && answer.intent === "disarm") {
        // A voice that disarms is a disarm like any other: it carries the PIN of the signed-in user (said or typed on the second turn) and gets the same refusals.
        const verdict = checkDisarm(context, studioUser(request), input.pin, actor(request));
        if (!verdict.allow) return response.status(verdict.status).json(verdict.body);
        if (verdict.duress) alarms.raiseDuress(actor(request));
        audit.record({ action: "control.disarm", outcome: "allowed", actor: actor(request), detail: verdict.duress ? "voice, duress" : "voice" });
        store.arm("disarmed"); executed = true; speech = spokenResult(language, { intent: "disarm" }); result = { mode: "disarmed" };
      } else if (answer.accepted && answer.intent === "status") {
        const state = store.snapshot();
        const nodes = Object.values(state.nodes);
        const summary = { mode: state.mode, alarms: alarms.active().length, online: nodes.filter(node => node.online).length, nodes: nodes.length };
        executed = true; speech = spokenResult(language, { intent: "status", ...summary }); result = summary;
      } else if (answer.accepted && answer.intent === "silence") {
        // A voice command proves nobody either (anybody near the microphone can say it): the alarms leave the unread list but a critical one keeps being escalated.
        const acknowledged = alarms.acknowledgeAll(actor(request), { verified: false });
        audit.record({ action: "alarm.acknowledge", outcome: "allowed", actor: actor(request), detail: `voice, all (${acknowledged})` });
        executed = true; speech = spokenResult(language, { intent: "silence", acknowledged }); result = { acknowledged };
      } else if (answer.accepted && answer.intent && ANSWERED_HERE.has(answer.intent)) {
        const done = await carryOut(answer.intent, language, context, actor(request));
        if (done) { executed = true; speech = done.speech; result = done.result; }
      }
      // What was said is never written down here: the audit trail holds the command and its outcome, not the words.
      audit.record({ action: "voice.command", outcome: executed ? "allowed" : "denied", actor: actor(request), detail: `${answer.intent ?? "none"}: ${answer.outcome ?? ""}` });
      return response.json({
        accepted: answer.accepted, executed, intent: answer.intent ?? null, outcome: answer.outcome ?? "", speech,
        ...(answer.confirmation_token ? { confirmation_token: answer.confirmation_token } : {}), ...(answer.reason ? { reason: answer.reason } : {}), ...(result ? { result } : {}),
      });
    } catch (error) {
      if (error instanceof VoiceError) return response.status(error.status).json({ error: error.code });
      return response.status(500).json({ error: "internal error" });
    }
  });
}
