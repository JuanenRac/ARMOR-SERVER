/**
 * The PIN that stands between a signed-in user and a disarm, for every route that can disarm (the mode of the system, and a command to an alarm node) and for silencing the siren of a panel: the PIN of the user is asked
 * whenever the user has one (setting alarm.disarm_pin: `if_set`, the default), never (`never`), or also of a user without one, who then cannot disarm (`always`, or ARMOR_DISARM_PIN=required, which wins over the setting). The duress PIN lets the disarm through and raises a critical alarm in silence.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AppContext } from "../context.js";

export type DisarmVerdict = { allow: true; duress: boolean } | { allow: false; status: 403 | 429; body: Record<string, unknown> };

/** Who may disarm without a PIN, as it is in force: the environment (ARMOR_DISARM_PIN) wins over the setting alarm.disarm_pin. */
export const disarmPinMode = (context: AppContext): "never" | "if_set" | "always" => context.config.disarmPinEnv ?? context.securitySettings.get("alarm.disarm_pin");

/** `what` is only for the audit trail: silencing a siren is as sensitive as disarming, so it asks for the same PIN under the same lockout. */
export function checkDisarm(context: AppContext, user: { id: string } | undefined, pin: unknown, actor: string, what: "disarm" | "silence" = "disarm"): DisarmVerdict {
  const { audit, users } = context;
  const mode = disarmPinMode(context);
  // `never`: no PIN is asked, so a wrong or missing one stops nothing. The duress PIN is the exception: it is still recognised when it is typed, so that it keeps raising its silent alarm.
  const typed = typeof pin === "string" && pin !== "";
  const result = !user ? "none" : mode === "never" && !typed ? "none" : users.verifyPin(user.id, pin);
  if (mode === "never" && (result === "bad" || result === "locked")) return { allow: true, duress: false };
  if (result === "locked") {
    audit.record({ action: `control.${what}`, outcome: "denied", actor, detail: "pin locked" });
    return { allow: false, status: 429, body: { error: "too many wrong PINs; try again later", code: "pin_locked", retry_after_s: user ? users.pinLockedFor(user.id) : 60 } };
  }
  if (result === "bad") {
    audit.record({ action: `control.${what}`, outcome: "denied", actor, detail: "wrong pin" });
    return { allow: false, status: 403, body: { error: "the PIN is not right", code: "wrong_pin" } };
  }
  if (result === "none" && mode === "always") {
    audit.record({ action: `control.${what}`, outcome: "denied", actor, detail: "no pin set" });
    return { allow: false, status: 403, body: { error: "this user has no PIN to disarm with; an administrator sets it", code: "pin_not_set" } };
  }
  return { allow: true, duress: result === "duress" };
}
