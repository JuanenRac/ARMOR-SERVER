/**
 * The calendar day of a moment, in ONE time zone for the whole server: the one in ARMOR_TZ (an IANA name such as Europe/Madrid) or, when it is not set, the one of the machine. The
 * kilowatt-hours of the solar equipment and of the electrical nodes are added up per day, and a day that ended at midnight for one and at 01:00 or 02:00 for the other made the
 * production and the consumption of "the same day" different slices of time.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
const zone = (): string | undefined => {
  const name = process.env.ARMOR_TZ?.trim();
  if (!name) return undefined;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: name }); return name; } catch { return undefined; }
};

export function dayOf(ms: number): string {
  // en-CA writes a date as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
