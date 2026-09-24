/**
 * A failure of a camera or media operation whose message is safe to show an
 * operator: it never contains a stream URL, a credential or a stack trace.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export class MediaError extends Error {
  constructor(message: string) { super(message); this.name = "MediaError"; }
}

export const mediaError = (message: string): MediaError => new MediaError(message);

/** The message to send to a client: known failures verbatim, anything else generic. */
export const clientMessage = (error: unknown, fallback: string): string => error instanceof MediaError ? error.message : fallback;
