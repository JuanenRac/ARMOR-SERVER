/** Generated from src/armor_common/ports.json by tools/generate_ports.py. Do not edit. */

export const ARMOR_PORTS = {
  server: 18080,
  studio: 18081,
  mqtt: 18883,
  voice: 18090,
  mqtt_tls: 8883,
  https: 8443,
  acme_http: 8081,
} as const;

export type ArmorPortName = keyof typeof ARMOR_PORTS;
