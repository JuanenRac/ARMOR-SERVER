import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArmorApp, type ArmorApp } from "../src/app.js";
import { readConfig, type ArmorConfig } from "../src/config.js";

export const SECRETS = {
  ARMOR_INGEST_TOKEN: "i".repeat(32),
  ARMOR_CONTROL_TOKEN: "c".repeat(32),
  ARMOR_OPERATOR_TOKEN: "o".repeat(32),
  ARMOR_CAMERA_CONFIG_KEY: "k".repeat(40),
  ARMOR_STUDIO_USERNAME: "admin",
  ARMOR_STUDIO_PASSWORD: "correct-horse-battery",
};

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "armor-test-"));
}

export function testConfig(extra: Record<string, string> = {}): ArmorConfig {
  return readConfig({ ...SECRETS, ARMOR_DATA_DIR: tempDir(), ...extra });
}

export type Running = { app: ArmorApp; base: string; config: ArmorConfig; stop: () => Promise<void> };

export async function startServer(extra: Record<string, string> = {}): Promise<Running> {
  const config = testConfig(extra);
  const app = createArmorApp(config, "test");
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { app, base, config, stop: () => app.close() };
}

/** Log in as the Studio user and return the cookie header to send back. */
export async function studioCookie(base: string): Promise<string> {
  const response = await fetch(`${base}/api/v1/studio/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: SECRETS.ARMOR_STUDIO_USERNAME, password: SECRETS.ARMOR_STUDIO_PASSWORD }),
  });
  if (response.status !== 201) throw new Error(`login returned ${response.status}`);
  return (response.headers.getSetCookie()[0] ?? "").split(";")[0];
}
