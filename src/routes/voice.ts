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
import crypto from "node:crypto";

const MAX_TURN_AUDIO_BYTES = 480_000;

const MAX_TEXT = 200;

export function registerVoiceRoutes(app: Express, context: AppContext): void {
  const { config, store, alarms, audit, requireOperator, studioUser } = context;
  const actor = (request: Request): string => studioUser(request)?.username ?? "operator";
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

  /** Whether written and spoken commands are available on this install (the phone asks before it shows the microphone). */
  app.get("/api/v1/voice/status", requireOperator, (_request, response) => response.json({ available: config.voice !== null }));

  /**
   * The wall panel speaks to the voice gateway through this server: the gateway listens on this machine only, and the panel is another device. The panel sends its audio here with the
   * voice token it was given (the same one the gateway asks for); the server passes it on, with the address of the panel so each panel has its own pending question, and gives back
   * the answer as it is. Both paths name the same thing: the second lets the panel's own setting be this server's address plus `/api/v1/voice` (it adds `/v1/turn` itself).
   */
  const turnLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const turn = async (request: Request, response: import("express").Response) => {
    if (!config.voice) return response.status(503).json({ error: "voice_unavailable" });
    const given = Buffer.from(String(request.headers["x-armor-voice-token"] ?? "")), wanted = Buffer.from(config.voice.token);
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) { audit.record({ action: "voice.turn", outcome: "denied" }); return response.status(401).json({ error: "unauthorized" }); }
    try { context.connections.seen({ ...context.sightingOf(request), kind: "voice" }); } catch { /* the history never stops a turn */ }
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (body.length === 0) return response.status(411).json({ error: "bad audio length" });
    try {
      const reply = await fetch(`${config.voice.url.replace(/\/$/, "")}/v1/turn`, {
        method: "POST", body: new Uint8Array(body), signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "audio/L16;rate=16000", "X-Armor-Voice-Token": config.voice.token, "X-Armor-Language": String(request.headers["x-armor-language"] ?? "en"), "X-Armor-Client": request.ip ?? "panel" },
      });
      const text = await reply.text();
      audit.record({ action: "voice.turn", outcome: reply.ok ? "allowed" : "denied", detail: String(reply.status) });
      return response.status(reply.status).type("application/json").send(text.slice(0, 400_000));
    } catch { return response.status(503).json({ error: "voice_not_answering" }); }
  };
  const turnBody = express.raw({ type: () => true, limit: MAX_TURN_AUDIO_BYTES });
  app.post("/api/v1/voice/turn", turnLimit, turnBody, turn);
  app.post("/api/v1/voice/v1/turn", turnLimit, turnBody, turn);

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
      const subject = (studioUser(request)?.id ?? "operator").slice(0, 64);
      const answer = await askVoice(config.voice, { text, language, subject, ...(confirmation ? { confirmation } : {}) });
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
