/**
 * The calendar day of a moment, in ONE time zone for the whole server: the one in ARMOR_TZ (an IANA name such as Europe/Madrid) or, when it is not set, the one of the machine. The
 * kilowatt-hours of the solar equipment and of the electrical nodes are added up per day, and a day that ended at midnight for one and at 01:00 or 02:00 for the other made the
 * production and the consumption of "the same day" different slices of time.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
const checkedZones = new Map<string, string | undefined>();
const zone = (): string | undefined => {
  const name = process.env.ARMOR_TZ?.trim();
  if (!name) return undefined;
  if (!checkedZones.has(name)) {
    if (checkedZones.size > 16) checkedZones.clear();
    try { new Intl.DateTimeFormat("en-CA", { timeZone: name }); checkedZones.set(name, name); } catch { checkedZones.set(name, undefined); }
  }
  return checkedZones.get(name);
};

/** Building a formatter costs far more than using it (it loads the locale and the zone data), so one is kept per zone: the daily log and the energy sums ask for a day on every sample. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: "day" | "time"): Intl.DateTimeFormat {
  const timeZone = zone();
  const key = `${kind}|${timeZone ?? ""}`;
  let known = formatters.get(key);
  if (!known) {
    // en-CA writes a date as YYYY-MM-DD
    known = kind === "day" ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      : new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(key, known);
  }
  return known;
}

export function dayOf(ms: number): string {
  return formatter("day").format(new Date(ms));
}

/** The second of the day (0 to 86399) of a moment, in the same time zone as dayOf. */
export function secondOfDay(ms: number): number {
  const parts = formatter("time").formatToParts(new Date(ms));
  const at = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? 0);
  return at("hour") * 3600 + at("minute") * 60 + at("second");
}
