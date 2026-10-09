/**
 * What the commands of the voice gateway that ask - the alarms, the nodes, the cameras, the radars, the solar equipment, the consumption, the network, the time, the help - answer
 * from what this server already knows, and the one that does (the lights on and off) - told in the language of the person. Arming, disarming, the state and the silence of the
 * alarms are in routes/voice.ts. Nothing here reads more than the person could read in the console.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AppContext } from "./context.js";
import { spokenResult, type VoiceLanguage } from "./voice.js";

type Words = {
  alarms: string; nodes: string; nodesOffline: string; nodesNone: string; cameras: string; camerasBad: string; camerasNone: string;
  radar: string; radarNone: string; radarNoNodes: string; solar: string; solarBattery: string; solarNone: string;
  electrical: string; electricalFeeds: string; electricalNone: string; network: string; networkNone: string; time: string; help: string;
  lightsOn: string; lightsOff: string; lightsNone: string; lightsFailed: string;
  /** The internet: up, degraded, down, lan_down, unknown. */
  internet: readonly [string, string, string, string, string];
};

const WORDS: Record<VoiceLanguage, Words> = {
  en: {
    alarms: "{0} active alarm(s), {1} of them serious.", nodes: "{0} of {1} node(s) online.", nodesOffline: " Without connection: {0}.", nodesNone: "No node has reported yet.",
    cameras: "{0} of {1} camera(s) answering.", camerasBad: " Not answering: {0}.", camerasNone: "There are no cameras set up.",
    radar: "The radars see {0} person(s).", radarNone: "The radars see no one.", radarNoNodes: "No radar node is online.",
    solar: "Solar: {0} W from the panels, {1} W used by the house.", solarBattery: " Battery at {0}%.", solarNone: "No solar equipment reports.",
    electrical: "The house draws {0} W from the grid.", electricalFeeds: "The house is giving {0} W to the grid.", electricalNone: "No electrical node reports.",
    network: "Internet is {0}. {1} device(s) on the network.", networkNone: "The network node does not report.", time: "It is {0}.",
    help: "I can arm and disarm the system, tell the state, the alarms, the nodes, the cameras, the radars, the solar system, the consumption, the network and the time, turn the lights on and off, and silence the alarm.",
    lightsOn: "{0} light(s) turned on.", lightsOff: "{0} light(s) turned off.", lightsNone: "There are no lights set up.", lightsFailed: " {0} could not be reached.",
    internet: ["working", "slow", "down", "unreachable, the local network is down", "unknown"],
  },
  es: {
    alarms: "{0} alarma(s) activa(s), {1} de ellas grave(s).", nodes: "{0} de {1} nodo(s) en línea.", nodesOffline: " Sin conexión: {0}.", nodesNone: "Ningún nodo ha informado todavía.",
    cameras: "{0} de {1} cámara(s) responden.", camerasBad: " No responden: {0}.", camerasNone: "No hay cámaras configuradas.",
    radar: "Los radares ven {0} persona(s).", radarNone: "Los radares no ven a nadie.", radarNoNodes: "Ningún nodo de radar está en línea.",
    solar: "Solar: {0} W de los paneles, {1} W de consumo de la casa.", solarBattery: " Batería al {0}%.", solarNone: "Ningún equipo solar informa.",
    electrical: "La casa consume {0} W de la red.", electricalFeeds: "La casa está entregando {0} W a la red.", electricalNone: "Ningún nodo eléctrico informa.",
    network: "Internet está {0}. {1} dispositivo(s) en la red.", networkNone: "El nodo de red no informa.", time: "Son las {0}.",
    help: "Puedo armar y desarmar el sistema, decirte el estado, las alarmas, los nodos, las cámaras, los radares, el sistema solar, el consumo, la red y la hora, encender y apagar las luces, y silenciar la alarma.",
    lightsOn: "{0} luz/luces encendida(s).", lightsOff: "{0} luz/luces apagada(s).", lightsNone: "No hay luces configuradas.", lightsFailed: " {0} no han respondido.",
    internet: ["funcionando", "lento", "caído", "inalcanzable, la red local está caída", "desconocido"],
  },
  de: {
    alarms: "{0} aktive(r) Alarm(e), davon {1} schwerwiegend.", nodes: "{0} von {1} Knoten online.", nodesOffline: " Ohne Verbindung: {0}.", nodesNone: "Noch kein Knoten hat sich gemeldet.",
    cameras: "{0} von {1} Kamera(s) antworten.", camerasBad: " Antworten nicht: {0}.", camerasNone: "Es sind keine Kameras eingerichtet.",
    radar: "Die Radare sehen {0} Person(en).", radarNone: "Die Radare sehen niemanden.", radarNoNodes: "Kein Radarknoten ist online.",
    solar: "Solar: {0} W von den Modulen, {1} W Verbrauch des Hauses.", solarBattery: " Batterie bei {0}%.", solarNone: "Keine Solaranlage meldet sich.",
    electrical: "Das Haus bezieht {0} W aus dem Netz.", electricalFeeds: "Das Haus speist {0} W ins Netz ein.", electricalNone: "Kein Elektro-Knoten meldet sich.",
    network: "Das Internet ist {0}. {1} Gerät(e) im Netzwerk.", networkNone: "Der Netzwerkknoten meldet sich nicht.", time: "Es ist {0}.",
    help: "Ich kann das System scharf- und entschärfen, den Status, die Alarme, die Knoten, die Kameras, die Radare, die Solaranlage, den Verbrauch, das Netzwerk und die Uhrzeit sagen, das Licht ein- und ausschalten und den Alarm stummschalten.",
    lightsOn: "{0} Licht(er) eingeschaltet.", lightsOff: "{0} Licht(er) ausgeschaltet.", lightsNone: "Es sind keine Lichter eingerichtet.", lightsFailed: " {0} waren nicht erreichbar.",
    internet: ["in Betrieb", "langsam", "ausgefallen", "nicht erreichbar, das lokale Netzwerk ist ausgefallen", "unbekannt"],
  },
  fr: {
    alarms: "{0} alarme(s) active(s), dont {1} grave(s).", nodes: "{0} nœud(s) sur {1} en ligne.", nodesOffline: " Sans connexion : {0}.", nodesNone: "Aucun nœud n'a encore donné de nouvelles.",
    cameras: "{0} caméra(s) sur {1} répondent.", camerasBad: " Ne répondent pas : {0}.", camerasNone: "Aucune caméra n'est configurée.",
    radar: "Les radars voient {0} personne(s).", radarNone: "Les radars ne voient personne.", radarNoNodes: "Aucun nœud radar n'est en ligne.",
    solar: "Solaire : {0} W des panneaux, {1} W consommés par la maison.", solarBattery: " Batterie à {0}%.", solarNone: "Aucun équipement solaire ne donne de nouvelles.",
    electrical: "La maison tire {0} W du réseau.", electricalFeeds: "La maison renvoie {0} W au réseau.", electricalNone: "Aucun nœud électrique ne donne de nouvelles.",
    network: "Internet est {0}. {1} appareil(s) sur le réseau.", networkNone: "Le nœud réseau ne donne pas de nouvelles.", time: "Il est {0}.",
    help: "Je peux armer et désarmer le système, dire l'état, les alarmes, les nœuds, les caméras, les radars, le solaire, la consommation, le réseau et l'heure, allumer et éteindre les lumières, et faire taire l'alarme.",
    lightsOn: "{0} lumière(s) allumée(s).", lightsOff: "{0} lumière(s) éteinte(s).", lightsNone: "Aucune lumière n'est configurée.", lightsFailed: " {0} n'ont pas répondu.",
    internet: ["en marche", "lent", "coupé", "injoignable, le réseau local est coupé", "inconnu"],
  },
  it: {
    alarms: "{0} allarme/i attivo/i, {1} grave/i.", nodes: "{0} nodo/i su {1} online.", nodesOffline: " Senza connessione: {0}.", nodesNone: "Nessun nodo ha ancora riferito.",
    cameras: "{0} telecamera/e su {1} rispondono.", camerasBad: " Non rispondono: {0}.", camerasNone: "Non ci sono telecamere configurate.",
    radar: "I radar vedono {0} persona/e.", radarNone: "I radar non vedono nessuno.", radarNoNodes: "Nessun nodo radar è online.",
    solar: "Solare: {0} W dai pannelli, {1} W consumati dalla casa.", solarBattery: " Batteria al {0}%.", solarNone: "Nessun impianto solare riferisce.",
    electrical: "La casa preleva {0} W dalla rete.", electricalFeeds: "La casa sta cedendo {0} W alla rete.", electricalNone: "Nessun nodo elettrico riferisce.",
    network: "Internet è {0}. {1} dispositivo/i sulla rete.", networkNone: "Il nodo di rete non riferisce.", time: "Sono le {0}.",
    help: "Posso armare e disarmare il sistema, dirti lo stato, gli allarmi, i nodi, le telecamere, i radar, il solare, il consumo, la rete e l'ora, accendere e spegnere le luci e silenziare l'allarme.",
    lightsOn: "{0} luce/i accesa/e.", lightsOff: "{0} luce/i spenta/e.", lightsNone: "Non ci sono luci configurate.", lightsFailed: " {0} non hanno risposto.",
    internet: ["funzionante", "lento", "interrotto", "irraggiungibile, la rete locale è interrotta", "sconosciuto"],
  },
  ja: {
    alarms: "有効なアラームは{0}件、そのうち重大なものは{1}件です。", nodes: "{1}台中{0}台のノードがオンラインです。", nodesOffline: " 接続なし：{0}。", nodesNone: "まだ報告したノードはありません。",
    cameras: "{1}台中{0}台のカメラが応答しています。", camerasBad: " 応答なし：{0}。", camerasNone: "カメラは設定されていません。",
    radar: "レーダーは{0}人を検知しています。", radarNone: "レーダーは誰も検知していません。", radarNoNodes: "オンラインのレーダーノードはありません。",
    solar: "ソーラー：パネルから{0} W、家の消費は{1} Wです。", solarBattery: " バッテリーは{0}%です。", solarNone: "報告しているソーラー機器はありません。",
    electrical: "家は系統から{0} W を使っています。", electricalFeeds: "家は系統へ{0} W を送っています。", electricalNone: "報告している電気ノードはありません。",
    network: "インターネットは{0}です。ネットワーク上の機器は{1}台です。", networkNone: "ネットワークノードが報告していません。", time: "{0}です。",
    help: "システムの警備開始と解除、状態、アラーム、ノード、カメラ、レーダー、ソーラー、電力消費、ネットワーク、時刻をお答えし、照明の点灯と消灯、アラームの停止ができます。",
    lightsOn: "{0}個の照明をつけました。", lightsOff: "{0}個の照明を消しました。", lightsNone: "照明は設定されていません。", lightsFailed: " {0}個は応答しませんでした。",
    internet: ["正常", "低速", "停止中", "到達不能（ローカルネットワークが停止中）", "不明"],
  },
  zh: {
    alarms: "有 {0} 个活动报警，其中 {1} 个严重。", nodes: "{1} 个节点中有 {0} 个在线。", nodesOffline: " 无连接：{0}。", nodesNone: "还没有节点上报。",
    cameras: "{1} 个摄像头中有 {0} 个有响应。", camerasBad: " 无响应：{0}。", camerasNone: "没有配置摄像头。",
    radar: "雷达看到 {0} 个人。", radarNone: "雷达没有看到任何人。", radarNoNodes: "没有在线的雷达节点。",
    solar: "太阳能：光伏 {0} W，房屋用电 {1} W。", solarBattery: " 电池电量 {0}%。", solarNone: "没有太阳能设备上报。",
    electrical: "房屋从电网取电 {0} W。", electricalFeeds: "房屋向电网送电 {0} W。", electricalNone: "没有电气节点上报。",
    network: "互联网{0}。网络中有 {1} 台设备。", networkNone: "网络节点没有上报。", time: "现在是 {0}。",
    help: "我可以布防和撤防系统，告诉你状态、报警、节点、摄像头、雷达、太阳能、用电、网络和时间，开关灯，以及静音报警。",
    lightsOn: "已打开 {0} 盏灯。", lightsOff: "已关闭 {0} 盏灯。", lightsNone: "没有配置灯。", lightsFailed: " {0} 盏无响应。",
    internet: ["正常", "缓慢", "已断开", "无法到达，本地网络已断开", "未知"],
  },
};

const fill = (text: string, ...values: Array<string | number>) => text.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)] ?? ""));
const INTERNET_ORDER = ["up", "degraded", "down", "lan_down", "unknown"] as const;
const list = (items: string[]) => items.slice(0, 3).join(", ") + (items.length > 3 ? ` +${items.length - 3}` : "");

export type VoiceActionContext = Pick<AppContext, "store" | "alarms" | "cameraWatcher" | "vault" | "solar" | "electricalNodes" | "networkNodes" | "devices" | "sendDeviceCommand" | "audit">;
export type ActionResult = { speech: string; result: Record<string, unknown> };

/** The commands of the gateway that this file answers; the others (arm, disarm, status, silence) are carried out in routes/voice.ts. */
export const ANSWERED_HERE = new Set(["alarms", "nodes", "cameras", "radar", "solar", "electrical", "network", "time", "help", "lights_on", "lights_off"]);

export async function carryOut(intent: string, language: VoiceLanguage, context: VoiceActionContext, actor: string, now: Date = new Date()): Promise<ActionResult | undefined> {
  const words = WORDS[language];
  switch (intent) {
    case "alarms": {
      const active = context.alarms.active();
      if (active.length === 0) return { speech: noAlarmsText(language), result: { active: 0, serious: 0 } };
      const serious = active.filter(alarm => alarm.severity === "critical" || alarm.severity === "high").length;
      return { speech: fill(words.alarms, active.length, serious), result: { active: active.length, serious } };
    }
    case "nodes": {
      const nodes = Object.entries(context.store.snapshot().nodes);
      if (nodes.length === 0) return { speech: words.nodesNone, result: { online: 0, nodes: 0 } };
      const offline = nodes.filter(([, node]) => !node.online).map(([id]) => id);
      return { speech: fill(words.nodes, nodes.length - offline.length, nodes.length) + (offline.length ? fill(words.nodesOffline, list(offline)) : ""), result: { online: nodes.length - offline.length, nodes: nodes.length, offline } };
    }
    case "cameras": {
      const cameras = context.vault.list();
      if (cameras.length === 0) return { speech: words.camerasNone, result: { answering: 0, cameras: 0 } };
      const health = new Map(context.cameraWatcher.snapshot().map(item => [item.id, item.status]));
      const silent = cameras.filter(camera => health.get(camera.id) !== "online").map(camera => camera.name);
      return { speech: fill(words.cameras, cameras.length - silent.length, cameras.length) + (silent.length ? fill(words.camerasBad, list(silent)) : ""), result: { answering: cameras.length - silent.length, cameras: cameras.length, silent } };
    }
    case "radar": {
      const online = Object.values(context.store.snapshot().nodes).filter(node => node.online);
      if (online.length === 0) return { speech: words.radarNoNodes, result: { people: 0, nodes: 0 } };
      const people = online.reduce((sum, node) => sum + node.target_count, 0);
      return { speech: people > 0 ? fill(words.radar, people) : words.radarNone, result: { people, nodes: online.length } };
    }
    case "solar": {
      const totals = context.solar.totals();
      if (totals.inverters + totals.batteries === 0) return { speech: words.solarNone, result: {} };
      return { speech: fill(words.solar, Math.round(totals.pv_w), Math.round(totals.load_w)) + (totals.soc_percent !== null ? fill(words.solarBattery, Math.round(totals.soc_percent)) : ""), result: { pv_w: totals.pv_w, load_w: totals.load_w, soc_percent: totals.soc_percent } };
    }
    case "electrical": {
      const grid = context.electricalNodes.totals().grid_w;
      if (grid === null) return { speech: words.electricalNone, result: {} };
      return { speech: grid >= 0 ? fill(words.electrical, Math.round(grid)) : fill(words.electricalFeeds, Math.round(-grid)), result: { grid_w: grid } };
    }
    case "network": {
      const totals = context.networkNodes.totals();
      if (totals.internet === null) return { speech: words.networkNone, result: {} };
      return { speech: fill(words.network, words.internet[INTERNET_ORDER.indexOf(totals.internet)] ?? words.internet[4], totals.online), result: { internet: totals.internet, devices_online: totals.online } };
    }
    case "time": {
      const text = now.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
      return { speech: fill(words.time, text), result: { time: text } };
    }
    case "help": return { speech: words.help, result: {} };
    case "lights_on":
    case "lights_off": {
      const command = intent === "lights_on" ? "on" : "off";
      const lights = context.devices.list().filter(device => device.kind === "smart_light");
      if (lights.length === 0) return { speech: words.lightsNone, result: { lights: 0 } };
      const failed: string[] = [];
      for (const light of lights) {
        try {
          await context.sendDeviceCommand(light.id, command);
          context.audit.record({ action: "device.command", outcome: "allowed", actor, target: `${light.id}=${command}`, detail: "voice" });
        } catch {
          failed.push(light.name);
          context.audit.record({ action: "device.command", outcome: "failed", actor, target: `${light.id}=${command}`, detail: "voice" });
        }
      }
      const done = lights.length - failed.length;
      return { speech: fill(command === "on" ? words.lightsOn : words.lightsOff, done) + (failed.length ? fill(words.lightsFailed, list(failed)) : ""), result: { lights: lights.length, done, failed } };
    }
    default: return undefined;
  }
}

/** "There are no active alarms", in the language (the same sentence the silence command says when there is nothing to silence). */
function noAlarmsText(language: VoiceLanguage): string { return spokenResult(language, { intent: "silence", acknowledged: 0 }); }
