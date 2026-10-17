/**
 * A proof of custody for one piece of evidence: what the file is (its size and SHA-256 now), when and by which camera it was made, and every line of the audit trail that touched it
 * (who protected it, who looked at its hash...), all signed by the server. A person can hand it over with the file; anyone who has the server can ask it whether the document is genuine
 * (the signature is a keyed hash, so it cannot be checked without the server's key) and whether the file still has the same digest. Nothing in it is secret.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type CustodyLine = { at: string; action: string; outcome: string; actor?: string; target?: string };
export type ProofFile = { camera: string; kind: string; name: string; bytes: number; created_at: string; sha256: string; protected: boolean };
export type Proof = {
  version: 1;
  issued_at: string;
  issuer: "armor-server";
  file: ProofFile;
  custody: CustodyLine[];
  /**
   * Whether the audit trail reaches back to the moment the file was made: false when the oldest line still kept is later than that (older lines were rotated away), so the custody
   * shown starts in the middle of the story. `audit_from` is the time of that oldest line. Absent in the proofs issued before this was recorded.
   */
  custody_complete?: boolean;
  audit_from?: string | null;
  signature: { algorithm: "HMAC-SHA256"; value: string };
};

const key = (secret: string): Buffer => createHash("sha256").update(`armor-evidence-proof|${secret}`).digest();

/** A stable text of the document without its signature: the keys in a fixed order, so the same content always signs the same. */
function canonical(proof: Omit<Proof, "signature">): string {
  const file = proof.file;
  return JSON.stringify({
    version: proof.version, issued_at: proof.issued_at, issuer: proof.issuer,
    file: { camera: file.camera, kind: file.kind, name: file.name, bytes: file.bytes, created_at: file.created_at, sha256: file.sha256, protected: file.protected },
    custody: proof.custody.map(line => ({ at: line.at, action: line.action, outcome: line.outcome, actor: line.actor ?? null, target: line.target ?? null })),
    ...(proof.custody_complete !== undefined ? { custody_complete: proof.custody_complete, audit_from: proof.audit_from ?? null } : {}),
  });
}

export function buildProof(secret: string, file: ProofFile, custody: CustodyLine[], issuedAt: Date = new Date(), coverage?: { auditFrom: string | null }): Proof {
  const complete = coverage === undefined ? undefined : coverage.auditFrom !== null && Date.parse(coverage.auditFrom) <= Date.parse(file.created_at);
  const body: Omit<Proof, "signature"> = { version: 1, issued_at: issuedAt.toISOString(), issuer: "armor-server", file, custody, ...(complete === undefined ? {} : { custody_complete: complete, audit_from: coverage!.auditFrom }) };
  return { ...body, signature: { algorithm: "HMAC-SHA256", value: createHmac("sha256", key(secret)).update(canonical(body)).digest("hex") } };
}

/** Whether the document is exactly what this server signed (nothing added, removed or changed). */
export function verifyProof(secret: string | readonly string[], value: unknown): value is Proof {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Proof;
  if (proof.version !== 1 || proof.issuer !== "armor-server" || typeof proof.signature?.value !== "string" || !/^[0-9a-f]{64}$/.test(proof.signature.value)) return false;
  if (typeof proof.file !== "object" || proof.file === null || !Array.isArray(proof.custody) || proof.custody.length > 5000) return false;
  const { signature, ...body } = proof;
  const given = Buffer.from(signature.value, "hex");
  // Any of the keys the server has signed with (a proof outlives the rotation of a key: it is checked against the keys still known).
  for (const candidate of typeof secret === "string" ? [secret] : secret) {
    let expected: Buffer;
    try { expected = createHmac("sha256", key(candidate)).update(canonical(body)).digest(); } catch { return false; }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** The lines of the audit trail that concern one file (by its path) in the order they happened. */
export function custodyOf(lines: ReadonlyArray<Record<string, unknown>>, target: string): CustodyLine[] {
  return lines
    .filter(line => typeof line.target === "string" && line.target === target && typeof line.at === "string" && typeof line.action === "string" && typeof line.outcome === "string")
    .map(line => ({ at: line.at as string, action: line.action as string, outcome: line.outcome as string, ...(typeof line.actor === "string" ? { actor: line.actor } : {}), target }));
}
