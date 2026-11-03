/* kopiert aus planungstool (src/domain/mailKopfzeilen.js), nicht hier ändern – scripts/regeln-holen.mjs, mit kleinen Ersetzungen für Gmail */
import { kopfDekodieren } from "./emlLesen.js";

/* ============================================================
   Die Kopfzeilen einer Mail lesen – für die Mailprüfung (19.10.2026)

   WEM MAN GLAUBEN KANN. Fast alles in den Kopfzeilen schreibt der
   Absender selbst, auch die Zeilen, die nach Prüfergebnis aussehen
   („Authentication-Results: spf=pass …"). Verlässlich ist nur, was
   UNSERE Rechner beim Empfang eingetragen haben. Gemessen an 336 Mails
   aus I:\Auftraege (19.10.2026) läuft der Empfang so:

       Internet → Sophos-Firewall (mail.oli-gmbh.de, Exim)
                → Exchange (oli-EX.oli-GmbH.local) → Postfach

   Daraus folgt, was hier gelesen wird:

   - Die `Received`-Zeile, in der `mail.oli-gmbh.de` die Mail ANNIMMT.
     Die Adresse darin (`[40.107.162.99]`) hat unsere Firewall selbst
     gesehen – das ist der sendende Rechner, und gegen ihn wird SPF
     geprüft. Alles darunter hat der Absender geschrieben.
   - `X-MS-Exchange-Organization-AuthAs`: `Internal` heißt „aus dem
     Haus", `Anonymous` heißt „von außen". Exchange entfernt diese
     Zeilen aus fremden Mails, bevor es seine eigenen setzt; sie lassen
     sich von draußen nicht unterschieben.
   - `X-SASI-SpamProbability` und `X-SASI-Hits` von Sophos. Echte
     Geschäftspost lag in der Stichprobe zwischen 6 und 19 %.

   WAS SOPHOS NICHT TUT: SPF prüfen. Seine Regel `ARCAUTH_PASSED`
   übernimmt nur, was das Absendersystem behauptet. Deshalb prüft der
   Server SPF selbst nach (domain/spf.js).

   `Authentication-Results` und `ARC-Authentication-Results` werden
   trotzdem gelesen – als BEHAUPTUNG des Absendersystems, nie als
   Beweis. Meldet selbst das Absendersystem ein Scheitern, ist das
   allerdings ein Befund.
   ============================================================ */

/* Wer bei uns Mail aus dem Internet annimmt. */
export const EINGANG_HOSTS = ["mx.google.com"];

/* Den Kopfblock in Zeilen zerlegen, Fortsetzungen angehängt, kodierte
   Wörter aufgelöst. Ein eingefügter Text darf auch den Rumpf enthalten
   – gelesen wird bis zur ersten Leerzeile. */
export function kopfzeilenZerlegen(text) {
  const zeilen = String(text || "").replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").split("\n");
  const raus = [];
  for (const z of zeilen) {
    if (!z.trim()) { if (raus.length) break; continue; }
    if (/^[ \t]/.test(z) && raus.length) { raus[raus.length - 1].roh += " " + z.trim(); continue; }
    const m = z.match(/^([!-9;-~]+):[ \t]?(.*)$/);
    if (m) raus.push({ name: m[1], roh: m[2] });
    if (raus.length > 2000) break;
  }
  return raus.map((z) => ({ name: z.name, wert: kopfDekodieren(z.roh).trim() }));
}

export const kopfAlle = (kopf, name) => {
  const n = name.toLowerCase();
  return (kopf || []).filter((z) => z.name.toLowerCase() === n).map((z) => z.wert);
};
export const kopfErster = (kopf, name) => kopfAlle(kopf, name)[0] || "";

/* `"Wolf, Gregor" <g@x.de>`, `Gregor <g@x.de>`, `g@x.de (Gregor)`,
   `<g@x.de>` – Name, Adresse und Domain. Bei einer Liste zählt die
   erste Adresse. */
export function adresseZerlegen(wert) {
  const s = String(wert || "").trim();
  if (!s) return { name: "", adresse: "", domain: "" };
  const spitz = s.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^>]*)>/);
  let name = "", adresse = "";
  if (spitz) {
    name = (spitz[1] ?? spitz[2] ?? "").replace(/\\(.)/g, "$1").trim();
    adresse = spitz[3].trim();
  } else {
    const m = s.match(/([^\s,;<>"()]+@[^\s,;<>"()]+)/);
    adresse = m ? m[1] : "";
    name = ((s.match(/\(([^)]*)\)/) || [])[1] || "").trim();
  }
  const at = adresse.lastIndexOf("@");
  return { name, adresse, domain: at >= 0 ? adresse.slice(at + 1).toLowerCase().replace(/\.$/, "") : "" };
}

/* ------------------------------------------------------------------
   Eine `Received`-Zeile. Zwei Schreibweisen kommen hier vor:

     Exim (Sophos):  from rdns.name ([40.107.162.99]:39276 helo=HELO) by mail.oli-gmbh.de …
     Exchange:       from oli-EX.oli-GmbH.local (192.168.1.16) by oli-EX… …
   ------------------------------------------------------------------ */
const IP4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
const IP6 = /\[(?:IPv6:)?([0-9a-f]*:[0-9a-f:.]+)(?:%\w+)?\]/i;

export function receivedZerlegen(wert) {
  const s = String(wert || "");
  const by = s.search(/\sby\s/i);
  const vonTeil = by >= 0 ? s.slice(0, by) : s;
  const name = ((vonTeil.match(/^\s*from\s+(\S+)/i) || [])[1] || "").replace(/[()[\]]/g, "");
  const ip = (vonTeil.match(IP6) || [])[1] || (vonTeil.match(IP4) || [])[1] || "";
  const helo = ((vonTeil.match(/helo=([^\s)\]]+)/i) || [])[1] || name).toLowerCase();
  const durch = ((s.slice(by >= 0 ? by : s.length).match(/\sby\s+(\S+)/i) || [])[1] || "").toLowerCase();
  const zeit = s.includes(";") ? s.slice(s.lastIndexOf(";") + 1).trim() : "";
  return { name: name.toLowerCase(), ip, helo, durch, zeit };
}

export function privateIp(ip) {
  const s = String(ip || "").toLowerCase();
  if (!s) return true;
  if (s.includes(":")) return s === "::1" || /^fe[89ab]/.test(s) || /^f[cd]/.test(s);
  const [a, b] = s.split(".").map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/* ------------------------------------------------------------------
   Wo kam die Mail zu uns herein? Rückgabe { ip, name, helo, durch,
   sicher, stufen } oder null.

   `sicher` ist nur dann wahr, wenn die Zeile von unserem eigenen
   Eingang stammt. Ohne sie (eingefügte Kopfzeilen einer fremden
   Installation) wird ersatzweise die oberste Zeile mit einer
   öffentlichen Adresse genommen – das ist meist richtig, aber nicht
   verbürgt, und die Oberfläche sagt das.
   ------------------------------------------------------------------ */
export function eingangFinden(kopf, eingang = EINGANG_HOSTS) {
  const stufen = kopfAlle(kopf, "Received").map(receivedZerlegen);
  const unser = eingang.map((h) => h.toLowerCase());
  const eigen = stufen.find((r) => unser.includes(r.durch) && r.ip && !privateIp(r.ip));
  if (eigen) return { ...eigen, sicher: true, stufen };
  const erste = stufen.find((r) => r.ip && !privateIp(r.ip));
  return erste ? { ...erste, sicher: false, stufen } : (stufen.length ? { ip: "", name: "", helo: "", durch: "", sicher: false, stufen } : null);
}

/* Exchange: aus dem Haus oder von außen, und seine Spam-Stufe. */
export function exchangeAngaben(kopf) {
  const scl = kopfErster(kopf, "X-MS-Exchange-Organization-SCL");
  return {
    authAs: kopfErster(kopf, "X-MS-Exchange-Organization-AuthAs"),
    scl: scl === "" || isNaN(+scl) ? null : +scl,
    richtung: kopfErster(kopf, "X-MS-Exchange-Organization-MessageDirectionality"),
  };
}

/* Sophos. `regeln` sind die Treffer mit Gewicht über null, ohne die
   internen `__`-Zwischenregeln – die sind Rechenschritte, keine
   Aussagen. Steht eine Zeile DOPPELT da, hat sie vermutlich jemand
   mitgeschickt, um gut auszusehen. */
export function sophosAngaben(kopf) {
  const p = kopfAlle(kopf, "X-SASI-SpamProbability");
  const hits = kopfErster(kopf, "X-SASI-Hits");
  const regeln = hits.split(",").map((h) => h.trim().split(/\s+/))
    .filter(([n, g]) => n && !n.startsWith("__") && +g > 0)
    .map(([name, g]) => ({ name, gewicht: +g }))
    .sort((a, b) => b.gewicht - a.gewicht);
  const wert = parseInt(p[0], 10);
  return { wahrscheinlichkeit: isNaN(wert) ? null : wert, regeln, doppelt: p.length > 1 };
}

/* Was das ABSENDERSYSTEM über sich selbst sagt. Die ARC-Zeile mit i=1
   ist die erste Prüfung unterwegs (bei Microsoft 365 die des Absenders
   selbst). Ergebnis je Verfahren: "pass", "fail", "none" … oder "". */
export function absenderBehauptung(kopf) {
  const quellen = [...kopfAlle(kopf, "ARC-Authentication-Results"), ...kopfAlle(kopf, "Authentication-Results")];
  const lies = (s, was) => ((s.match(new RegExp(`\\b${was}=(\\w+)`, "i")) || [])[1] || "").toLowerCase();
  for (const s of quellen) {
    const r = { spf: lies(s, "spf"), dkim: lies(s, "dkim"), dmarc: lies(s, "dmarc") };
    if (r.spf || r.dkim || r.dmarc) {
      const wer = (s.replace(/^\s*i=\d+;\s*/, "").match(/^\s*([\w.-]+)/) || [])[1] || "";
      return { ...r, wer };
    }
  }
  const spfZeile = kopfErster(kopf, "Received-SPF");
  if (spfZeile) return { spf: (spfZeile.match(/^\s*(\w+)/) || [])[1]?.toLowerCase() || "", dkim: "", dmarc: "", wer: "Received-SPF" };
  return null;
}
