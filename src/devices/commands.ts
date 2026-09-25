/**
 * Sending a command to an actuator: over MQTT (a payload on the device's command topic) or over HTTP (a GET to a URL on the local
 * network). A command a kind does not understand is refused before anything is sent. Nothing here ever logs a URL or a payload.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { kindInfo } from "./catalog.js";
import { DeviceError, isLanUrl, type Device, type DeviceRegistry } from "./registry.js";

export type Command = "on" | "off" | "toggle";
export const isCommand = (value: unknown): value is Command => value === "on" || value === "off" || value === "toggle";

export type CommandDeps = {
  publish?: (topic: string, payload: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** The state field a command sets (a lock is "locked", a valve "open", the rest "on"). */
export const commandField = (device: Device): "on" | "locked" | "open" => (device.kind === "lock" ? "locked" : device.kind === "valve" ? "open" : "on");

/** What a toggle turns into, from the state the device last reported. */
export function resolveToggle(device: Device): "on" | "off" { return device.state[commandField(device)] === true ? "off" : "on"; }

export async function sendCommand(registry: DeviceRegistry, id: string, command: Command, deps: CommandDeps): Promise<{ via: "mqtt" | "http"; command: "on" | "off" | "toggle" }> {
  const device = registry.get(id);
  if (!device) throw new DeviceError("not_found", "no such device", 404);
  if (!(kindInfo(device.kind).commands as readonly string[]).includes(command)) throw new DeviceError("unsupported_command", "this kind of device does not take that command");
  const mqtt = device.commands.mqtt, http = device.commands.http;
  if (!mqtt && !http) throw new DeviceError("no_command_channel", "this device has no command topic or URL set up", 409);
  const controller = deps.timeoutMs ?? 5000;
  // Where the device has no toggle of its own, a toggle is the opposite of what it last reported.
  const resolved = command === "toggle" && !((mqtt?.toggle) || (http?.toggle)) ? resolveToggle(device) : command;

  if (mqtt && mqtt[resolved] !== undefined && deps.publish) {
    await deps.publish(mqtt.topic, mqtt[resolved] as string);
    if (mqtt.assume_state && resolved !== "toggle") registry.applyState(id, { [commandField(device)]: resolved === "on" });
    return { via: "mqtt", command: resolved };
  }
  const url = http?.[resolved];
  if (url) {
    if (!isLanUrl(url)) throw new DeviceError("invalid_url", "the command URL is not on the local network");
    const response = await (deps.fetchImpl ?? fetch)(url, { method: "GET", signal: AbortSignal.timeout(controller), redirect: "error" }).catch(() => undefined);
    if (!response || !response.ok) throw new DeviceError("command_failed", "the device did not accept the command", 409);
    if (resolved !== "toggle") registry.applyState(id, { [commandField(device)]: resolved === "on" });
    return { via: "http", command: resolved };
  }
  throw new DeviceError("no_command_channel", `this device has nothing set up for "${resolved}"`, 409);
}
