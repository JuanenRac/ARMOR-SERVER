/**
 * The optional encryption of the link to the MQTT broker (mqtts) with the certificate of the installation's own authority.
 *
 * Off unless ARMOR_MQTT_URL is an mqtts:// address. ARMOR_MQTT_CA_FILE names a file with ONE certificate in PEM (the authority that signed the broker's certificate, which
 * ARMOR-DEVOPS' scripts/armor_mqtt_tls.sh exports); when it is set that authority is the only one trusted for this connection and the broker's name or address must be among the names
 * its certificate vouches for. Without it an mqtts:// address is checked against the machine's usual authorities.
 */
import { X509Certificate } from "node:crypto";
import fs from "node:fs";

export type MqttCa = { pem: string; fingerprint256: string; subject: string; validTo: string };

const BEGIN = "-----BEGIN CERTIFICATE-----";
const END = "-----END CERTIFICATE-----";
const MAX_CA_BYTES = 8 * 1024;

/** One certificate in PEM and nothing else; anything else (a key, two certificates, text around it, a certificate that has expired) is refused with the reason. */
export function parseCaPem(text: string, now = Date.now()): MqttCa {
  const pem = text.replace(/\r\n/g, "\n").trim() + "\n";
  if (pem.length > MAX_CA_BYTES) throw new Error("it is too large to be a certificate");
  if (!pem.startsWith(BEGIN + "\n") || !pem.endsWith("\n" + END + "\n") || pem.split(BEGIN).length !== 2 || pem.split(END).length !== 2) throw new Error("it is not one certificate in PEM (from BEGIN CERTIFICATE to END CERTIFICATE)");
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(pem); } catch { throw new Error("it is not a valid certificate"); }
  if (Date.parse(certificate.validTo) < now) throw new Error(`the certificate expired on ${certificate.validTo}`);
  if (Date.parse(certificate.validFrom) > now) throw new Error(`the certificate is not valid until ${certificate.validFrom}`);
  return { pem, fingerprint256: certificate.fingerprint256, subject: certificate.subject.replace(/\n/g, ", "), validTo: new Date(certificate.validTo).toISOString() };
}

export function readCaFile(file: string): MqttCa {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_CA_BYTES) throw new Error("it is too large to be a certificate");
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(error instanceof Error && error.message.startsWith("it is") ? error.message : "it cannot be read");
  }
  return parseCaPem(text);
}

export const isTlsUrl = (url: string): boolean => /^(mqtts|wss):\/\//i.test(url.trim());

/** What Studio shows: whether the link to the broker is encrypted and, when an authority is pinned, which one (never a path or a key). */
export function mqttTlsState(mqtt: { url: string; ca?: MqttCa } | null): { configured: boolean; tls: boolean; pinned_ca: boolean; ca?: { fingerprint256: string; subject: string; valid_to: string } } {
  if (!mqtt) return { configured: false, tls: false, pinned_ca: false };
  return {
    configured: true, tls: isTlsUrl(mqtt.url), pinned_ca: mqtt.ca !== undefined,
    ...(mqtt.ca ? { ca: { fingerprint256: mqtt.ca.fingerprint256, subject: mqtt.ca.subject, valid_to: mqtt.ca.validTo } } : {}),
  };
}
