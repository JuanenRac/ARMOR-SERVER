/**
 * The PIN that stands between a signed-in user and a disarm, for every route that can disarm (the mode of the system, and a command to an alarm node) and for silencing the siren of a panel: the PIN of the user is asked
 * whenever the user has one, and with ARMOR_DISARM_PIN=required a user without one cannot disarm. The duress PIN lets the disarm through and raises a critical alarm in silence.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AppContext } from "../context.js";

export type DisarmVerdict = { allow: true; duress: boolean } | { allow: false; status: 403 | 429; body: Record<string, unknown> };

/** `what` is only for the audit trail: silencing a siren is as sensitive as disarming, so it asks for the same PIN under the same lockout. */
export function checkDisarm(context: AppContext, user: { id: string } | undefined, pin: unknown, actor: string, what: "disarm" | "silence" = "disarm"): DisarmVerdict {
  const { audit, users, config } = context;
  const result = user ? users.verifyPin(user.id, pin) : "none";
  if (result === "locked") {
    audit.record({ action: `control.${what}`, outcome: "denied", actor, detail: "pin locked" });
    return { allow: false, status: 429, body: { error: "too many wrong PINs; try again later", code: "pin_locked", retry_after_s: user ? users.pinLockedFor(user.id) : 60 } };
  }
  if (result === "bad") {
    audit.record({ action: `control.${what}`, outcome: "denied", actor, detail: "wrong pin" });
    return { allow: false, status: 403, body: { error: "the PIN is not right", code: "wrong_pin" } };
  }
  if (result === "none" && config.disarmPinRequired) {
    audit.record({ action: `control.${what}`, outcome: "denied", actor, detail: "no pin set" });
    return { allow: false, status: 403, body: { error: "this user has no PIN to disarm with; an administrator sets it", code: "pin_not_set" } };
  }
  return { allow: true, duress: result === "duress" };
}
