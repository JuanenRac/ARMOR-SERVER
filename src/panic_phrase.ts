/**
 * The silent panic phrase: a secret sentence a person says (or types) to the voice assistant when they are being forced. It equals the duress PIN: it raises the silent
 * duress alarm and nothing else (the mode is not touched and the answer looks like any command that was not understood). Each user has their own, kept only as a salted scrypt
 * hash; what was said is never written down. The option `voice.panic_phrase` is off by default and `voice.panic_cooldown_s` is the quiet time after one trigger.
 *
 * The phrase is compared after a language-independent normalisation (Unicode NFKC, lower case, punctuation dropped, spaces collapsed), so the same phrase is recognised whatever
 * the language of the console, and it can be chosen in any of the eight languages. This file holds only the rules of the phrase; the hash lives in users.ts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */

/** The fewest words of a phrase (3), or, for a script written without spaces (Japanese, Chinese), the fewest characters (8): a short phrase is said by accident. */
export const PANIC_MIN_WORDS = 3;
export const PANIC_MIN_CHARS_UNSPACED = 8;
export const PANIC_MAX_CHARS = 120;

/** What a console should show as the placeholder; it is never accepted as a phrase. */
export const PANIC_EXAMPLE_PHRASES: readonly string[] = [
  "the weather is nice today", "hace buen tiempo hoy", "heute ist das wetter schon", "il fait beau aujourdhui", "oggi fa bel tempo", "今日はいい天気ですね", "今天天气很好啊今天", "hoje esta bom tempo",
];

/** Words of a closed command of the assistant: a phrase made only of these would be an ordinary command, said every day. */
const COMMON = new Set(["arm", "disarm", "status", "silence", "stop", "help", "armar", "desarmar", "estado", "silenciar", "ayuda", "socorro", "alarm", "alarma", "alarme", "the", "system", "sistema", "please", "por", "favor"]);

/** Lower case, punctuation out, spaces collapsed. Letters and digits of every script stay. */
export function normalisePhrase(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** What is wrong with a phrase someone wants to set, as a stable code; undefined when it is acceptable. */
export function phraseProblem(text: unknown): "invalid_phrase" | "phrase_too_short" | "phrase_too_long" | "phrase_too_common" | "phrase_is_example" | undefined {
  if (typeof text !== "string") return "invalid_phrase";
  if (text.length > PANIC_MAX_CHARS * 2) return "phrase_too_long";
  const normal = normalisePhrase(text);
  if (normal.length > PANIC_MAX_CHARS) return "phrase_too_long";
  const words = normal === "" ? [] : normal.split(" ");
  // One long word counts only in a script written without spaces; in any other a single word is one word, however long.
  const unspaced = words.length === 1 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normal);
  if (unspaced ? [...normal].length < PANIC_MIN_CHARS_UNSPACED : words.length < PANIC_MIN_WORDS) return "phrase_too_short";
  if (PANIC_EXAMPLE_PHRASES.some(example => normalisePhrase(example) === normal)) return "phrase_is_example";
  if (words.every(word => COMMON.has(word))) return "phrase_too_common";
  return undefined;
}
