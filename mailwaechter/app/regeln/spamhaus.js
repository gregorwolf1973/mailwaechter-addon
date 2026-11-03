/* kopiert aus planungstool (src/domain/spamhaus.js), nicht hier ändern – scripts/regeln-holen.mjs */
/* ============================================================
   Sperrlisten für die Mailprüfung (21.10.2026, Gregor Wolf: „baue alles
   ein, was erlaubt ist … und baue auch die Abfrage [Spamhaus] ein")

   Hier steht nur, was sich ohne Netz rechnen lässt – Namen bauen und
   Antworten deuten. Abgefragt wird auf dem Server
   (server/sperrlisten.js), die Befunde schreibt domain/mailPruefung.js.

   1. SPAMHAUS DQS (Data Query Service) – DNS-Abfragen mit eigenem
      Schlüssel (`MAILPRUEFUNG_SPAMHAUS_DQS` in der .env). Ohne Schlüssel
      wird nichts gefragt. Drei Zonen:
        DBL  Domains aus Spam, Phishing, Schadsoftware – auch für Links
        ZRD  Domains, die Spamhaus erst seit höchstens 24 Stunden kennt
        ZEN  der sendende Rechner (SBL, XBL, PBL, DROP)
      Antwort 127.x.x.x heißt gelistet, „gibt es nicht" heißt sauber.
      127.255.255.x sind Fehler der Abfrage, keine Treffer.

   2. FREIE IP-LISTEN, auch für Firmen erlaubt:
        Spamhaus DROP – gekaperte Netze, „frei, unabhängig von Größe und
          Art des Betriebs" (Quelle muss genannt werden: © The Spamhaus
          Project)
        abuse.ch Feodo Tracker – Steuerserver von Bank-Trojanern, CC0
      NICHT eingebaut, weil sie nur für nicht gewerbliche Zwecke frei
      sind: URLhaus (abuse.ch), OpenPhish, Google Safe Browsing.
   ============================================================ */

export const DQS_ZONEN = { dbl: "dbl.dq.spamhaus.net", zrd: "zrd.dq.spamhaus.net", zen: "zen.dq.spamhaus.net" };

/* IPv4 rückwärts („1.2.3.4" → „4.3.2.1"); IPv6 fragen wir nicht */
export function ipRueckwaerts(ip) {
  const t = String(ip || "").split(".");
  return t.length === 4 && t.every((x) => /^\d{1,3}$/.test(x) && +x <= 255) ? t.reverse().join(".") : "";
}

/* Der DNS-Name einer DQS-Abfrage – "" wenn nicht fragbar */
export function dqsName(zone, wert, schluessel) {
  const k = String(schluessel || "").trim();
  if (!/^[a-z0-9]{10,64}$/i.test(k) || !DQS_ZONEN[zone]) return "";
  const w = zone === "zen" ? ipRueckwaerts(wert) : String(wert || "").toLowerCase().replace(/\.$/, "");
  return w ? `${w}.${k}.${DQS_ZONEN[zone]}` : "";
}

/* Fehlercodes statt Treffer: dann stimmt die Abfrage nicht */
const FEHLER = {
  "127.255.255.252": "Abfragename falsch (Schlüssel prüfen)",
  "127.255.255.254": "Abfrage über einen öffentlichen Resolver – nicht erlaubt",
  "127.255.255.255": "zu viele Abfragen",
  "127.0.1.255": "IP-Adresse statt Domain gefragt",
};
export const dqsFehler = (antworten) => (antworten || []).map((a) => FEHLER[a]).find(Boolean) || "";

/* DBL: was für eine Domain ist es? `missbraucht` = eigentlich harmlose
   Domain, auf der etwas Böses liegt (gekaperte Website). */
const DBL = {
  "127.0.1.2": { art: "Spam" }, "127.0.1.4": { art: "Phishing" }, "127.0.1.5": { art: "Schadsoftware" }, "127.0.1.6": { art: "Botnetz-Steuerung" },
  "127.0.1.102": { art: "Spam", missbraucht: true }, "127.0.1.103": { art: "Weiterleitung für Spam", missbraucht: true },
  "127.0.1.104": { art: "Phishing", missbraucht: true }, "127.0.1.105": { art: "Schadsoftware", missbraucht: true },
  "127.0.1.106": { art: "Botnetz-Steuerung", missbraucht: true },
};
export function dblBedeutung(antworten) {
  const t = (antworten || []).map((a) => DBL[a]).filter(Boolean);
  if (!t.length) return null;
  /* Ein echter Eintrag schlägt „missbraucht" */
  return t.find((x) => !x.missbraucht) || t[0];
}

/* ZEN: welche Teilliste? PBL heißt nur „Endkunden-Anschluss, sollte
   nicht direkt senden" – bei uns kommt Post sonst über Mailserver. */
export function zenBedeutung(antworten) {
  const raus = [];
  for (const a of antworten || []) {
    const n = +String(a).split(".").pop();
    if (!String(a).startsWith("127.0.0.")) continue;
    if (n === 2) raus.push({ liste: "SBL", art: "bekannte Spamquelle" });
    else if (n === 3) raus.push({ liste: "SBL CSS", art: "Spam-Versand im großen Stil" });
    else if (n >= 4 && n <= 7) raus.push({ liste: "XBL", art: "gekaperter Rechner (Schadsoftware, Botnetz)" });
    else if (n === 9) raus.push({ liste: "DROP", art: "gekapertes Netz" });
    else if (n === 10 || n === 11) raus.push({ liste: "PBL", art: "Endkunden-Anschluss, sendet sonst nicht direkt" });
  }
  return raus;
}

/* ZRD: 127.0.2.x – die Domain kennt Spamhaus seit höchstens 24 Stunden */
export const zrdNeu = (antworten) => (antworten || []).some((a) => /^127\.0\.2\.\d+$/.test(String(a)));

/* ---------- Die freien Listen lesen ---------- */

/* Spamhaus DROP (drop_v4.json): eine JSON-Zeile je Netz, zuletzt die Metadaten */
export function dropLesen(text) {
  const raus = [];
  for (const z of String(text || "").split(/\r?\n/)) {
    if (!z.trim()) continue;
    try {
      const j = JSON.parse(z);
      const m = /^([\d.]+)\/(\d{1,2})$/.exec(j.cidr || "");
      if (m) raus.push({ netz: m[1], laenge: +m[2], kennung: j.sblid || "" });
    } catch { /* kaputte Zeile überspringen */ }
  }
  return raus;
}

/* abuse.ch Feodo Tracker (ipblocklist.txt): eine Adresse je Zeile, # = Kommentar */
export const feodoLesen = (text) => String(text || "").split(/\r?\n/).map((z) => z.trim())
  .filter((z) => z && !z.startsWith("#") && /^\d{1,3}(\.\d{1,3}){3}$/.test(z));
