/**
 * Written and spoken commands: the console or the phone sends what the person said (already turned into text where they are), the voice gateway (ARMOR-VOICE-AI, a
 * small service on this machine that listens on the loopback address only) says which of its four closed commands it is - and holds the two-turn confirmation of the
 * ones that change the security state - and this server carries out what was accepted, with the session of the person who spoke. The gateway decides; it never acts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */

export const VOICE_LANGUAGES = ["en", "es", "de", "fr", "it", "ja", "zh"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export type VoiceAnswer = {
  accepted: boolean;
  requires_confirmation?: boolean;
  intent?: string | null;
  outcome?: string;
  confirmation_token?: string;
  reason?: string;
  speech?: string;
  error?: string;
};

export type VoiceGateway = { url: string; token: string };

export class VoiceError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Asks the gateway about one phrase. Its refusals keep their meaning (a phrase that is not a command is an answer, not an error). */
export async function askVoice(gateway: VoiceGateway, request: { text: string; language?: string; confirmation?: string }): Promise<VoiceAnswer> {
  let reply: Response;
  try {
    reply = await fetch(`${gateway.url.replace(/\/$/, "")}/v1/command`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Armor-Voice-Token": gateway.token }, body: JSON.stringify(request), signal: AbortSignal.timeout(5_000),
    });
  } catch { throw new VoiceError(503, "voice_not_answering"); }
  if (reply.status === 401) throw new VoiceError(503, "voice_refused_the_token");
  const answer = await reply.json().catch(() => undefined) as VoiceAnswer | undefined;
  if (!answer || typeof answer !== "object") throw new VoiceError(502, "voice_bad_answer");
  if (reply.status === 413) throw new VoiceError(422, "text_too_long");
  if (answer.error === "invalid request fields" || answer.error === "invalid request shape") throw new VoiceError(422, "invalid_request");
  if (!reply.ok) throw new VoiceError(502, "voice_bad_answer");
  return answer;
}

type Words = {
  armed: string; disarmed: string; modeArmed: string; modeDisarmed: string;
  /** "{0}" is the mode, "{1}" the active alarms, "{2}" the nodes online and "{3}" all the nodes. */
  status: string; silenced: string; noAlarms: string;
};

const WORDS: Record<VoiceLanguage, Words> = {
  en: { armed: "System armed.", disarmed: "System disarmed.", modeArmed: "armed", modeDisarmed: "disarmed", status: "The system is {0}. {1} active alarm(s). {2} of {3} node(s) online.", silenced: "{0} alarm(s) silenced.", noAlarms: "There are no active alarms." },
  es: { armed: "Sistema armado.", disarmed: "Sistema desarmado.", modeArmed: "armado", modeDisarmed: "desarmado", status: "El sistema está {0}. {1} alarma(s) activa(s). {2} de {3} nodo(s) en línea.", silenced: "{0} alarma(s) silenciada(s).", noAlarms: "No hay alarmas activas." },
  de: { armed: "System scharfgeschaltet.", disarmed: "System entschärft.", modeArmed: "scharfgeschaltet", modeDisarmed: "entschärft", status: "Das System ist {0}. {1} aktive(r) Alarm(e). {2} von {3} Knoten online.", silenced: "{0} Alarm(e) stummgeschaltet.", noAlarms: "Es gibt keine aktiven Alarme." },
  fr: { armed: "Système armé.", disarmed: "Système désarmé.", modeArmed: "armé", modeDisarmed: "désarmé", status: "Le système est {0}. {1} alarme(s) active(s). {2} nœud(s) sur {3} en ligne.", silenced: "{0} alarme(s) réduite(s) au silence.", noAlarms: "Il n'y a aucune alarme active." },
  it: { armed: "Sistema armato.", disarmed: "Sistema disarmato.", modeArmed: "armato", modeDisarmed: "disarmato", status: "Il sistema è {0}. {1} allarme/i attivo/i. {2} nodo/i su {3} online.", silenced: "{0} allarme/i silenziato/i.", noAlarms: "Non ci sono allarmi attivi." },
  ja: { armed: "警備を開始しました。", disarmed: "警備を解除しました。", modeArmed: "警備中", modeDisarmed: "警備解除中", status: "システムは{0}です。有効なアラームは{1}件。オンラインのノードは{3}台中{2}台です。", silenced: "{0}件のアラームを止めました。", noAlarms: "有効なアラームはありません。" },
  zh: { armed: "已布防。", disarmed: "已撤防。", modeArmed: "已布防", modeDisarmed: "已撤防", status: "系统{0}。有 {1} 个活动报警。{3} 个节点中有 {2} 个在线。", silenced: "已消音 {0} 个报警。", noAlarms: "没有活动报警。" },
};

const fill = (text: string, ...values: Array<string | number>) => text.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)] ?? ""));

export const isVoiceLanguage = (value: unknown): value is VoiceLanguage => (VOICE_LANGUAGES as readonly unknown[]).includes(value);

/** What is said after a command has been carried out, in the language of the person. */
export function spokenResult(language: VoiceLanguage, result: { intent: "arm" | "disarm" } | { intent: "status"; mode: "armed" | "disarmed"; alarms: number; online: number; nodes: number } | { intent: "silence"; acknowledged: number }): string {
  const words = WORDS[language];
  switch (result.intent) {
    case "arm": return words.armed;
    case "disarm": return words.disarmed;
    case "status": return fill(words.status, result.mode === "armed" ? words.modeArmed : words.modeDisarmed, result.alarms, result.online, result.nodes);
    case "silence": return result.acknowledged > 0 ? fill(words.silenced, result.acknowledged) : words.noAlarms;
  }
}
