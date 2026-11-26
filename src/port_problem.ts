/**
 * A serial port of a solar gateway node that hears bytes and reads nothing. The node says it in one log line, which its health report carries as the last error, such as
 * "armor-ports: port 3 unreadable flat 115200bd rx16 tx15 n230 [00 00 00 00 00 00]" (ARMOR-NODE-SOLAR, core/port_diag.hpp). This module reads that line back, so a console can say
 * it in words, and keeps what each port said last: a report carries only one line, so with several ports they take turns.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export const PORT_CAUSES = ["flat", "echo", "noise", "text", "frames"] as const;
export type PortCause = (typeof PORT_CAUSES)[number];
export type PortProblem = { port: number; cause: PortCause; baud: number; rx: number; tx: number; inverted: boolean; bytes_heard: number; sample: string };
export type PortProblemView = PortProblem & { said_at: string };

/** A port stops being listed when its node has not said it again for this long (the node repeats an unreadable port every few minutes). */
export const PORT_PROBLEM_KEEP_MS = 30 * 60_000;

const LINE = /(?:^|: )port (\d{1,2}) unreadable (flat|echo|noise|text|frames) (\d{3,7})bd rx(-?\d{1,2}) tx(-?\d{1,2})( inv)? n(\d{1,10}) \[((?:[0-9A-F]{2}(?: [0-9A-F]{2}){0,5})?)\]$/;

/** The problem an error line tells, or undefined when the line is about something else (or was cut). */
export function parsePortProblem(line: string | undefined): PortProblem | undefined {
  const found = line === undefined ? null : LINE.exec(line);
  if (!found) return undefined;
  const port = Number(found[1]);
  if (port < 1 || port > 16) return undefined;
  return { port, cause: found[2] as PortCause, baud: Number(found[3]), rx: Number(found[4]), tx: Number(found[5]), inverted: found[6] !== undefined, bytes_heard: Number(found[7]), sample: found[8]! };
}

export type KeptPortProblem = { line: string; at: number; problem: PortProblem };

/**
 * Notes what a report says. The time is renewed only when the line is a new one: an old line stays "the last error" for as long as nothing else is logged, also after the port reads
 * again, while a port that is still unreadable says a new line (its count of bytes has grown).
 */
export function notePortProblem(kept: Map<number, KeptPortProblem>, lastError: string | undefined, now: number): void {
  const problem = parsePortProblem(lastError);
  if (!problem) return;
  if (kept.get(problem.port)?.line === lastError) return;
  kept.set(problem.port, { line: lastError!, at: now, problem });
}

/** The ports that are still listed, in the order of their number. */
export function currentPortProblems(kept: ReadonlyMap<number, KeptPortProblem>, now: number): PortProblemView[] {
  return [...kept.values()].filter(item => now - item.at <= PORT_PROBLEM_KEEP_MS).map(item => ({ ...item.problem, said_at: new Date(item.at).toISOString() })).sort((a, b) => a.port - b.port);
}
