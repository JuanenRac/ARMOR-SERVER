/**
 * What an alarm says, in words, for the places that show text to a person (Telegram, the notification of Home Assistant): the same events as alertMessageFor() in notify.ts,
 * told in the language the installation asks for (ARMOR_ALERT_LANGUAGE; Spanish when it is not set).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AlertMessage } from "./notify.js";
import { alarmCodeWords } from "./alarm_codes.js";

export const ALERT_LANGUAGES = ["en", "es", "de", "fr", "it", "ja", "zh", "pt"] as const;
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
  /** "{0}" is the person, "{1}" the address. */
  login: string;
  /** "{0}" is the person, "{1}" the address, "{2}" the country (a code): the sign-in is from a country that person never signed in from. */
  loginCountry: string;
  /** "{2}" is the minutes nobody has acknowledged an alarm. */
  escalated: string;
  armed: string; disarmed: string;
  /** The sentence for a duress disarm: the code means nothing to a person, and what to do about it is the point. */
  duress: string;
  critical: string; high: string; warning: string;
};

const WORDS: Record<AlertLanguage, Words> = {
  en: { title: "A.R.M.O.R.", loginCountry: "New sign-in of {0} from a country never used before, {2} ({1}). If it was not you, end the session and change the password.", login: "New sign-in of {0} from outside the house, from {1}. If it was not you, end the session and change the password.", raised: "ALERT on node {0}: {1} people detected while the system is armed.", cleared: "Alert cleared on node {0}.", offline: "Node {0} is offline while the system is armed.", stale: "Node {0} stopped reporting while the system is armed.", camera: "Camera {0} stopped answering while the system is armed.", alarm: "{0} alarm: {1} ({2}).", automation: "The automation {0} asks to notify.", test: "This is a test message: the alarms of A.R.M.O.R. reach this place.", escalated: "NOBODY HAS ACKNOWLEDGED IT after {2} min:", armed: "Armed", disarmed: "Disarmed", critical: "CRITICAL", high: "HIGH", warning: "Warning", duress: "DURESS: the system was disarmed with the duress PIN. Somebody may be forcing the person who did it. Do not call or message them: call for help." },
  es: { title: "A.R.M.O.R.", loginCountry: "Nuevo inicio de sesión de {0} desde un país que no había usado nunca, {2} ({1}). Si no has sido tú, cierra la sesión y cambia la contraseña.", login: "Nuevo inicio de sesión de {0} desde fuera de casa, desde {1}. Si no has sido tú, cierra la sesión y cambia la contraseña.", raised: "ALERTA en el nodo {0}: {1} personas detectadas con el sistema armado.", cleared: "Alerta terminada en el nodo {0}.", offline: "El nodo {0} está sin conexión con el sistema armado.", stale: "El nodo {0} ha dejado de informar con el sistema armado.", camera: "La cámara {0} ha dejado de responder con el sistema armado.", alarm: "Alarma {0}: {1} ({2}).", automation: "La automatización {0} pide avisar.", test: "Este es un mensaje de prueba: las alarmas de A.R.M.O.R. llegan hasta aquí.", escalated: "NADIE LA HA RECONOCIDO tras {2} min:", armed: "Armado", disarmed: "Desarmado", critical: "CRÍTICA", high: "ALTA", warning: "de aviso", duress: "COACCIÓN: el sistema se desarmó con el PIN de coacción. Puede que alguien esté obligando a quien lo hizo. No lo llames ni le escribas: pide ayuda." },
  de: { title: "A.R.M.O.R.", loginCountry: "Neue Anmeldung von {0} aus einem bisher nie genutzten Land, {2} ({1}). Wenn Sie es nicht waren, beenden Sie die Sitzung und ändern Sie das Passwort.", login: "Neue Anmeldung von {0} von außerhalb des Hauses, von {1}. Wenn Sie es nicht waren, beenden Sie die Sitzung und ändern Sie das Passwort.", raised: "ALARM am Knoten {0}: {1} Personen erkannt, während das System scharf ist.", cleared: "Alarm am Knoten {0} beendet.", offline: "Knoten {0} ist offline, während das System scharf ist.", stale: "Knoten {0} meldet sich nicht mehr, während das System scharf ist.", camera: "Kamera {0} antwortet nicht mehr, während das System scharf ist.", alarm: "{0}-Alarm: {1} ({2}).", automation: "Die Automatisierung {0} bittet um eine Benachrichtigung.", test: "Dies ist eine Testnachricht: Die Alarme von A.R.M.O.R. erreichen diesen Ort.", escalated: "NIEMAND HAT ES QUITTIERT nach {2} Min.:", armed: "Scharf", disarmed: "Entschärft", critical: "KRITISCHER", high: "HOHER", warning: "Warn", duress: "NÖTIGUNG: Das System wurde mit der Zwangs-PIN entschärft. Möglicherweise wird die Person gezwungen. Nicht anrufen oder schreiben: Hilfe holen." },
  fr: { title: "A.R.M.O.R.", loginCountry: "Nouvelle connexion de {0} depuis un pays jamais utilisé auparavant, {2} ({1}). Si ce n'était pas vous, fermez la session et changez le mot de passe.", login: "Nouvelle connexion de {0} depuis l'extérieur de la maison, depuis {1}. Si ce n'était pas vous, fermez la session et changez le mot de passe.", raised: "ALERTE sur le nœud {0} : {1} personnes détectées alors que le système est armé.", cleared: "Alerte terminée sur le nœud {0}.", offline: "Le nœud {0} est hors ligne alors que le système est armé.", stale: "Le nœud {0} ne donne plus de nouvelles alors que le système est armé.", camera: "La caméra {0} ne répond plus alors que le système est armé.", alarm: "Alarme {0} : {1} ({2}).", automation: "L'automatisation {0} demande de prévenir.", test: "Ceci est un message de test : les alarmes d'A.R.M.O.R. arrivent jusqu'ici.", escalated: "PERSONNE NE L'A ACQUITTÉE après {2} min :", armed: "Armé", disarmed: "Désarmé", critical: "CRITIQUE", high: "ÉLEVÉE", warning: "d'avertissement", duress: "CONTRAINTE : le système a été désarmé avec le code de contrainte. Quelqu'un force peut-être la personne. Ne l'appelez pas et ne lui écrivez pas : appelez des secours." },
  it: { title: "A.R.M.O.R.", loginCountry: "Nuovo accesso di {0} da un paese mai usato prima, {2} ({1}). Se non sei stato tu, chiudi la sessione e cambia la password.", login: "Nuovo accesso di {0} da fuori casa, da {1}. Se non sei stato tu, chiudi la sessione e cambia la password.", raised: "ALLERTA sul nodo {0}: {1} persone rilevate con il sistema armato.", cleared: "Allerta terminata sul nodo {0}.", offline: "Il nodo {0} è offline con il sistema armato.", stale: "Il nodo {0} ha smesso di riferire con il sistema armato.", camera: "La telecamera {0} ha smesso di rispondere con il sistema armato.", alarm: "Allarme {0}: {1} ({2}).", automation: "L'automazione {0} chiede di avvisare.", test: "Questo è un messaggio di prova: gli allarmi di A.R.M.O.R. arrivano fin qui.", escalated: "NESSUNO L'HA RICONOSCIUTA dopo {2} min:", armed: "Armato", disarmed: "Disarmato", critical: "CRITICO", high: "ALTO", warning: "di avviso", duress: "COSTRIZIONE: il sistema è stato disarmato con il PIN di coercizione. Qualcuno potrebbe star costringendo la persona. Non chiamarla né scriverle: chiedi aiuto." },
  ja: { title: "A.R.M.O.R.", loginCountry: "{0} が、これまで使われたことのない国（{2}、{1}）からサインインしました。心当たりがない場合は、セッションを終了してパスワードを変更してください。", login: "{0} が家の外（{1}）からサインインしました。心当たりがない場合は、セッションを終了してパスワードを変更してください。", raised: "ノード {0} で警報：警備中に {1} 人を検知しました。", cleared: "ノード {0} の警報が解除されました。", offline: "警備中にノード {0} がオフラインです。", stale: "警備中にノード {0} からの報告が止まりました。", camera: "警備中にカメラ {0} が応答しなくなりました。", alarm: "{0} アラーム：{1}（{2}）。", automation: "オートメーション {0} が通知を求めています。", test: "これはテストメッセージです。A.R.M.O.R. の警報はここに届きます。", escalated: "{2} 分経っても誰も確認していません：", armed: "警備中", disarmed: "警備解除", critical: "重大", high: "高", warning: "注意", duress: "強要：強要用の暗証番号で解除されました。本人が脅されている可能性があります。本人に連絡せず、助けを呼んでください。" },
  pt: { title: "A.R.M.O.R.", loginCountry: "Novo início de sessão de {0} a partir de um país nunca utilizado antes, {2} ({1}). Se não foi o próprio, termine a sessão e altere a palavra-passe.", login: "Novo início de sessão de {0} a partir de fora de casa, de {1}. Se não foi o próprio, termine a sessão e altere a palavra-passe.", raised: "ALERTA no nó {0}: {1} pessoas detetadas com o sistema armado.", cleared: "Alerta terminado no nó {0}.", offline: "O nó {0} está offline com o sistema armado.", stale: "O nó {0} deixou de reportar com o sistema armado.", camera: "A câmara {0} deixou de responder com o sistema armado.", alarm: "Alarme {0}: {1} ({2}).", automation: "A automatização {0} pede para avisar.", test: "Esta é uma mensagem de teste: os alarmes do A.R.M.O.R. chegam até aqui.", escalated: "NINGUÉM O RECONHECEU após {2} min:", armed: "Armado", disarmed: "Desarmado", critical: "CRÍTICA", high: "ALTA", warning: "de aviso", duress: "COAÇÃO: o sistema foi desarmado com o PIN de coação. Alguém pode estar a obrigar quem o fez. Não lhe ligue nem escreva: peça ajuda." },
  zh: { title: "A.R.M.O.R.", loginCountry: "{0} 从以前从未使用过的国家（{2}，{1}）登录。如果不是您本人，请结束该会话并修改密码。", login: "{0} 从家外（{1}）登录。如果不是您本人，请结束该会话并修改密码。", raised: "节点 {0} 报警：布防期间检测到 {1} 人。", cleared: "节点 {0} 的报警已解除。", offline: "布防期间节点 {0} 离线。", stale: "布防期间节点 {0} 停止上报。", camera: "布防期间摄像头 {0} 停止响应。", alarm: "{0}报警：{1}（{2}）。", automation: "自动化 {0} 请求通知。", test: "这是一条测试消息：A.R.M.O.R. 的报警会送到这里。", escalated: "{2} 分钟内无人确认：", armed: "已布防", disarmed: "已撤防", critical: "严重", high: "高级", warning: "警告", duress: "胁迫：系统使用胁迫密码解除了布防。操作者可能正被人胁迫。不要联系本人，请立即求助。" },
};

const fill = (text: string, ...values: Array<string | number>) => text.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)] ?? ""));

/** The one line a person reads for an alarm, in the language asked for. */
export function alertText(message: AlertMessage, language: AlertLanguage): string {
  const words = WORDS[language];
  const where = message.device_id ?? message.solar_id ?? message.electrical_id ?? message.alarm_node_id ?? message.network_id ?? message.camera_id ?? message.node_id ?? "";
  const how = message.severity === "critical" ? words.critical : message.severity === "high" ? words.high : words.warning;
  const what = message.code ? alarmCodeWords(message.code, language) : "?";
  const text = (() => {
    switch (message.event) {
      case "alert.raised": return fill(words.raised, message.node_id ?? "?", message.targets ?? 0);
      case "alert.cleared": return fill(words.cleared, message.node_id ?? "?");
      case "node.offline": return fill(words.offline, message.node_id ?? "?");
      case "node.stale": return fill(words.stale, message.node_id ?? "?");
      case "camera.offline": return fill(words.camera, message.camera_id ?? "?");
      case "alarm.raised": return message.code === "duress_disarm" ? words.duress : fill(words.alarm, how, what, where || "?");
      case "alarm.escalated": return `${fill(words.escalated, how, what, message.minutes ?? 0)} ${fill(words.alarm, how, what, where || "?")}`;
      case "automation.notify": return fill(words.automation, message.automation ?? "?");
      case "login.remote": return message.login_country_new && message.login_country ? fill(words.loginCountry, message.login_user ?? "?", message.login_from ?? "?", message.login_country) : fill(words.login, message.login_user ?? "?", message.login_from ?? "?");
      case "alert.test": return words.test;
    }
  })();
  return `${text}\n${message.mode === "armed" ? words.armed : words.disarmed} · ${message.at}`;
}

export const alertTitle = (language: AlertLanguage): string => WORDS[language].title;
