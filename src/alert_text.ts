/**
 * What an alarm says, in words, for the places that show text to a person (Telegram, the notification of Home Assistant): the same events as alertMessageFor() in notify.ts,
 * told in the language the installation asks for (ARMOR_ALERT_LANGUAGE; Spanish when it is not set).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AlertMessage } from "./notify.js";

export const ALERT_LANGUAGES = ["en", "es", "de", "fr", "it", "ja", "zh"] as const;
export type AlertLanguage = (typeof ALERT_LANGUAGES)[number];
export const isAlertLanguage = (value: unknown): value is AlertLanguage => (ALERT_LANGUAGES as readonly unknown[]).includes(value);

type Words = {
  title: string;
  /** "{0}" is the node, "{1}" the number of people. */
  raised: string; cleared: string; offline: string; stale: string;
  /** "{0}" is the camera. */
  camera: string;
  /** "{0}" is how serious, "{1}" what it is, "{2}" where. */
  alarm: string;
  /** "{0}" is the automation. */
  automation: string;
  test: string;
  armed: string; disarmed: string;
  critical: string; high: string; warning: string;
};

const WORDS: Record<AlertLanguage, Words> = {
  en: { title: "A.R.M.O.R.", raised: "ALERT on node {0}: {1} people detected while the system is armed.", cleared: "Alert cleared on node {0}.", offline: "Node {0} is offline while the system is armed.", stale: "Node {0} stopped reporting while the system is armed.", camera: "Camera {0} stopped answering while the system is armed.", alarm: "{0} alarm: {1} ({2}).", automation: "The automation {0} asks to notify.", test: "This is a test message: the alarms of A.R.M.O.R. reach this place.", armed: "Armed", disarmed: "Disarmed", critical: "CRITICAL", high: "HIGH", warning: "Warning" },
  es: { title: "A.R.M.O.R.", raised: "ALERTA en el nodo {0}: {1} personas detectadas con el sistema armado.", cleared: "Alerta terminada en el nodo {0}.", offline: "El nodo {0} está sin conexión con el sistema armado.", stale: "El nodo {0} ha dejado de informar con el sistema armado.", camera: "La cámara {0} ha dejado de responder con el sistema armado.", alarm: "Alarma {0}: {1} ({2}).", automation: "La automatización {0} pide avisar.", test: "Este es un mensaje de prueba: las alarmas de A.R.M.O.R. llegan hasta aquí.", armed: "Armado", disarmed: "Desarmado", critical: "CRÍTICA", high: "ALTA", warning: "de aviso" },
  de: { title: "A.R.M.O.R.", raised: "ALARM am Knoten {0}: {1} Personen erkannt, während das System scharf ist.", cleared: "Alarm am Knoten {0} beendet.", offline: "Knoten {0} ist offline, während das System scharf ist.", stale: "Knoten {0} meldet sich nicht mehr, während das System scharf ist.", camera: "Kamera {0} antwortet nicht mehr, während das System scharf ist.", alarm: "{0}-Alarm: {1} ({2}).", automation: "Die Automatisierung {0} bittet um eine Benachrichtigung.", test: "Dies ist eine Testnachricht: Die Alarme von A.R.M.O.R. erreichen diesen Ort.", armed: "Scharf", disarmed: "Entschärft", critical: "KRITISCHER", high: "HOHER", warning: "Warn" },
  fr: { title: "A.R.M.O.R.", raised: "ALERTE sur le nœud {0} : {1} personnes détectées alors que le système est armé.", cleared: "Alerte terminée sur le nœud {0}.", offline: "Le nœud {0} est hors ligne alors que le système est armé.", stale: "Le nœud {0} ne donne plus de nouvelles alors que le système est armé.", camera: "La caméra {0} ne répond plus alors que le système est armé.", alarm: "Alarme {0} : {1} ({2}).", automation: "L'automatisation {0} demande de prévenir.", test: "Ceci est un message de test : les alarmes d'A.R.M.O.R. arrivent jusqu'ici.", armed: "Armé", disarmed: "Désarmé", critical: "CRITIQUE", high: "ÉLEVÉE", warning: "d'avertissement" },
  it: { title: "A.R.M.O.R.", raised: "ALLERTA sul nodo {0}: {1} persone rilevate con il sistema armato.", cleared: "Allerta terminata sul nodo {0}.", offline: "Il nodo {0} è offline con il sistema armato.", stale: "Il nodo {0} ha smesso di riferire con il sistema armato.", camera: "La telecamera {0} ha smesso di rispondere con il sistema armato.", alarm: "Allarme {0}: {1} ({2}).", automation: "L'automazione {0} chiede di avvisare.", test: "Questo è un messaggio di prova: gli allarmi di A.R.M.O.R. arrivano fin qui.", armed: "Armato", disarmed: "Disarmato", critical: "CRITICO", high: "ALTO", warning: "di avviso" },
  ja: { title: "A.R.M.O.R.", raised: "ノード {0} で警報：警備中に {1} 人を検知しました。", cleared: "ノード {0} の警報が解除されました。", offline: "警備中にノード {0} がオフラインです。", stale: "警備中にノード {0} からの報告が止まりました。", camera: "警備中にカメラ {0} が応答しなくなりました。", alarm: "{0} アラーム：{1}（{2}）。", automation: "オートメーション {0} が通知を求めています。", test: "これはテストメッセージです。A.R.M.O.R. の警報はここに届きます。", armed: "警備中", disarmed: "警備解除", critical: "重大", high: "高", warning: "注意" },
  zh: { title: "A.R.M.O.R.", raised: "节点 {0} 报警：布防期间检测到 {1} 人。", cleared: "节点 {0} 的报警已解除。", offline: "布防期间节点 {0} 离线。", stale: "布防期间节点 {0} 停止上报。", camera: "布防期间摄像头 {0} 停止响应。", alarm: "{0}报警：{1}（{2}）。", automation: "自动化 {0} 请求通知。", test: "这是一条测试消息：A.R.M.O.R. 的报警会送到这里。", armed: "已布防", disarmed: "已撤防", critical: "严重", high: "高级", warning: "警告" },
};

const fill = (text: string, ...values: Array<string | number>) => text.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)] ?? ""));

/** The one line a person reads for an alarm, in the language asked for. */
export function alertText(message: AlertMessage, language: AlertLanguage): string {
  const words = WORDS[language];
  const where = message.device_id ?? message.solar_id ?? message.electrical_id ?? message.node_id ?? "";
  const how = message.severity === "critical" ? words.critical : message.severity === "high" ? words.high : words.warning;
  const text = (() => {
    switch (message.event) {
      case "alert.raised": return fill(words.raised, message.node_id ?? "?", message.targets ?? 0);
      case "alert.cleared": return fill(words.cleared, message.node_id ?? "?");
      case "node.offline": return fill(words.offline, message.node_id ?? "?");
      case "node.stale": return fill(words.stale, message.node_id ?? "?");
      case "camera.offline": return fill(words.camera, message.camera_id ?? "?");
      case "alarm.raised": return fill(words.alarm, how, message.code ?? "?", where || "?");
      case "automation.notify": return fill(words.automation, message.automation ?? "?");
      case "alert.test": return words.test;
    }
  })();
  return `${text}\n${message.mode === "armed" ? words.armed : words.disarmed} · ${message.at}`;
}

export const alertTitle = (language: AlertLanguage): string => WORDS[language].title;
