/**
 * A.R.M.O.R. central server entry point.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import path from "node:path";
import { createArmorApp } from "./app.js";
import { ConfigError, loadDotEnv, readConfig } from "./config.js";
import pkg from "../package.json" with { type: "json" };

// `tsx watch` can restart its child without the launcher's variables on
// Windows, so the ignored local .env is read here too; real variables win.
loadDotEnv(path.resolve(process.cwd(), ".env"));

let config;
try { config = readConfig(); }
catch (error) {
  console.error(`ARMOR_SERVER=REFUSED ${error instanceof ConfigError ? error.message : "invalid configuration"}`);
  process.exit(1);
}

for (const warning of config.warnings) console.warn(`ARMOR_SERVER=WARNING ${warning}`);
if (config.tls) console.log(`ARMOR_SERVER=TLS_ENABLED cert=${config.tls.certPath} key=${config.tls.keyPath}`);
const armor = createArmorApp(config, pkg.version);
armor.server.listen(config.port, config.host, () => console.log(`ARMOR_SERVER=LISTENING address=${config.host}:${config.port} scheme=${config.tls ? "https" : "http"}`));

const shutdown = (signal: string) => {
  console.log(`ARMOR_SERVER=STOPPING signal=${signal}`);
  void armor.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
