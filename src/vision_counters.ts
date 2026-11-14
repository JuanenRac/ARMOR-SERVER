/**
 * How many events the vision service handed over, by kind (a zone alert, a detection zone, an activity event) and by what the server did with each (raised an alarm, only recorded,
 * ignored), kept in memory since the start and offered as counters on the Prometheus page. Only these fixed names are ever counted, so the page cannot grow with what a camera sees.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export const VISION_KINDS = ["alert", "detection", "activity"] as const;
export const VISION_OUTCOMES = ["raised", "recorded", "ignored"] as const;
export type VisionKind = (typeof VISION_KINDS)[number];
export type VisionOutcome = (typeof VISION_OUTCOMES)[number];
export type VisionCountRow = { kind: VisionKind; outcome: VisionOutcome; count: number };

export class VisionCounters {
  private readonly counts = new Map<string, number>();

  /** Counts one event; a name that is not one of the fixed ones is dropped. */
  record(kind: VisionKind, outcome: VisionOutcome): void {
    if (!VISION_KINDS.includes(kind) || !VISION_OUTCOMES.includes(outcome)) return;
    const key = `${kind}/${outcome}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Every combination, in a fixed order, zero included, so a scraper sees the series from the first scrape. */
  rows(): VisionCountRow[] {
    return VISION_KINDS.flatMap(kind => VISION_OUTCOMES.map(outcome => ({ kind, outcome, count: this.counts.get(`${kind}/${outcome}`) ?? 0 })));
  }
}
