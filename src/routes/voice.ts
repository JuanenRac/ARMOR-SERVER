/**
 * Written and spoken commands from the console and the phone: POST /api/v1/voice/command takes what the person said (as text), asks the voice gateway what it means
 * (see ../voice.ts) and carries out what was accepted - arm, disarm, say the state, silence the alarms - with the session of the person, in the audit trail. Arming and
 * disarming need a second turn: the first answers `confirmation-needed` with a token, the second repeats the phrase with it.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { askVoice, isVoiceLanguage, spokenResult, VoiceError, type VoiceLanguage } from "../voice.js";
import { ANSWERED_HERE, carryOut } from "../voice_actions.js";

const MAX_TEXT = 200;

export function registerVoiceRoutes(app: Express, context: AppContext): void {
  const { config, store, alarms, audit, requireOperator, studioUser } = context;
  const actor = (request: Request): string => studioUser(request)?.username ?? "operator";
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

  /** Whether written and spoken commands are available on this install (the phone asks before it shows the microphone). */
  app.get("/api/v1/voice/status", requireOperator, (_request, response) => response.json({ available: config.voice !== null }));

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
      const answer = await askVoice(config.voice, { text, language, ...(confirmation ? { confirmation } : {}) });
      let speech = answer.speech ?? "";
      let result: Record<string, unknown> | undefined;
      let executed = false;
      if (answer.accepted && answer.intent === "arm") {
        audit.record({ action: "control.arm", outcome: "allowed", actor: actor(request), detail: "voice" });
        store.arm("armed"); executed = true; speech = spokenResult(language, { intent: "arm" }); result = { mode: "armed" };
      } else if (answer.accepted && answer.intent === "disarm") {
        audit.record({ action: "control.disarm", outcome: "allowed", actor: actor(request), detail: "voice" });
        store.arm("disarmed"); executed = true; speech = spokenResult(language, { intent: "disarm" }); result = { mode: "disarmed" };
      } else if (answer.accepted && answer.intent === "status") {
        const state = store.snapshot();
        const nodes = Object.values(state.nodes);
        const summary = { mode: state.mode, alarms: alarms.active().length, online: nodes.filter(node => node.online).length, nodes: nodes.length };
        executed = true; speech = spokenResult(language, { intent: "status", ...summary }); result = summary;
      } else if (answer.accepted && answer.intent === "silence") {
        const acknowledged = alarms.acknowledgeAll(actor(request));
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
