/**
 * Which version of the shared contracts each node says its firmware was checked against, put next to the one this server speaks. The nodes say it in their health report; this is the
 * answer an operator, the doctor of the maintenance tools and Studio read without having to compare the numbers by hand.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type ContractRelation = "current" | "older" | "newer" | "unknown";

export type ContractNode = { node_id: string; family: string; contract: string | null; status: ContractRelation };
export type ContractStatus = {
  server: string;
  nodes: ContractNode[];
  totals: Record<ContractRelation, number>;
};

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/;

/** The parts of a version, with a missing fourth part as zero; undefined when it is not a version. */
export function versionParts(text: unknown): [number, number, number, number] | undefined {
  if (typeof text !== "string") return undefined;
  const match = VERSION.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)] : undefined;
}

/** How a node's version stands against the server's: the same, behind it, ahead of it, or not said (an older firmware, or something that is not a version). */
export function relation(said: unknown, server: string): ContractRelation {
  const mine = versionParts(said), wanted = versionParts(server);
  if (!mine || !wanted) return "unknown";
  for (let index = 0; index < 4; index += 1) if (mine[index] !== wanted[index]) return mine[index] < wanted[index] ? "older" : "newer";
  return "current";
}

/** The status of every node that has reported, in the order of their names. */
export function contractStatus(server: string, reports: Array<{ node_id: string; family: string; report: { contract?: unknown } }>): ContractStatus {
  const nodes = reports.map(item => ({
    node_id: item.node_id, family: item.family, contract: versionParts(item.report.contract) ? String(item.report.contract) : null, status: relation(item.report.contract, server),
  })).sort((a, b) => a.node_id.localeCompare(b.node_id));
  const totals: Record<ContractRelation, number> = { current: 0, older: 0, newer: 0, unknown: 0 };
  for (const node of nodes) totals[node.status] += 1;
  return { server, nodes, totals };
}
