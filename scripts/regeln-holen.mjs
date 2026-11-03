/* ============================================================
   Holt die Prüfregeln der Mailprüfung aus dem Planungstool

       node scripts/regeln-holen.mjs [Pfad-zum-planungstool]

   Die Dateien kommen UNVERÄNDERT nach mailwaechter/app/regeln/ – bis auf
   die kleinen, unten aufgezählten Ersetzungen für Gmail (kein Exchange,
   keine Sophos-Firewall, keine Firmen-Domain). Jede Ersetzung SCHEITERT
   LAUT, wenn der gesuchte Text im Original nicht mehr steht: dann hat sich
   das Planungstool geändert und hier muss jemand hinsehen.

   Über jede kopierte Datei kommt ein Kopfkommentar "kopiert aus
   planungstool, nicht hier ändern". Das Skript ändert NICHTS im
   Planungstool, es liest nur.

   Abgleichen später: Skript erneut laufen lassen, dann `git diff`.
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const hier = dirname(fileURLToPath(import.meta.url));
const ziel = join(hier, "..", "mailwaechter", "app", "regeln");
const quelle = process.argv[2] || "C:/Users/wolf/Code/planungstool";

/* Reihenfolge wie in werkzeuge/mailpruefung/bauen.mjs (MODULE) plus spf.js
   und spamhaus.js. `src/domain/...` → ./ ; sperrlisten.js liegt im Server. */
const DATEIEN = [
  "src/domain/rtfLesen.js",
  "src/domain/msgLesen.js",
  "src/domain/emlLesen.js",
  "src/domain/mailDomain.js",
  "src/domain/mailKopfzeilen.js",
  "src/domain/mailLinks.js",
  "src/domain/mailAnhangPruefung.js",
  "src/domain/mailInhaltPruefung.js",
  "src/domain/sha256.js",
  "src/domain/iban.js",
  "src/domain/domainAlter.js",
  "src/domain/anhangLinks.js",
  "src/domain/mailPruefung.js",
  "src/domain/mailPruefungEingabe.js",
  "src/domain/spf.js",
  "src/domain/spamhaus.js",
  "server/sperrlisten.js",
];

/* Datei → [[gesucht, ersatz, Grund], …]. Gesucht wird wörtlich, genau einmal. */
const ERSETZUNGEN = {
  "src/domain/mailDomain.js": [
    ['export const EIGENE_DOMAINS = ["oli-gmbh.de"];', "export const EIGENE_DOMAINS = [];",
      "Firmen-Domain; die eigenen Domains kommen aus den Add-on-Optionen (umfeld.eigene)"],
  ],
  "src/domain/mailKopfzeilen.js": [
    ['export const EINGANG_HOSTS = ["mail.oli-gmbh.de"];', 'export const EINGANG_HOSTS = ["mx.google.com"];',
      "Bei Gmail nimmt mx.google.com die Mail an; dessen Received-Zeile nennt den sendenden Rechner"],
  ],
  "src/domain/mailPruefung.js": [
    ['const wo = mitApplus ? "weder in AP+ noch in den Akten der laufenden Projekte" : "nicht in den Akten der laufenden Projekte";',
      'const wo = "nicht unter den Adressen, die du angeschrieben hast";',
      "kein AP+, keine Projektakten – bekannt ist, wem Gregor geschrieben hat"],
    ['mitApplus ? "Unbekannter Absender" : "Absender nicht im Mailindex"', '"Unbekannter Absender"',
      "dito, Titel"],
    ['/\\boli\\b|lingenfelder/i.test(von.name)', '/(?!)/.test(von.name)',
      "hart verdrahteter Firmenname (oli, Lingenfelder); passt nicht zu Gmail, trifft nie"],
    ["Mails von ${kollege} kommen von @${eigene[0]}.", 'Mails von ${kollege} kommen von der eigenen Adresse${eigene[0] ? ` (@${eigene[0]})` : ""}.',
      "eigene[0] kann bei Gmail fehlen"],
    ["ist aber keine Adresse von @${eigene[0]}.", 'ist aber keine eigene Adresse${eigene[0] ? ` (@${eigene[0]})` : ""}.',
      "eigene[0] kann bei Gmail fehlen"],
    ["prüft der Planungstool-Server – ohne Verbindung zu ihm fällt diese Prüfung weg.", "prüft das Add-on über das Netz – ohne Verbindung fällt diese Prüfung weg.",
      "kein Planungstool-Server"],
    ['"Absenderdomain ahmt oli nach"', '"Absenderdomain ahmt eine eigene Domain nach"', "Firmenname im Befundtext"],
    ["${info.mails} Mails in den Akten${info.zuletzt ? `, zuletzt vom ${datumKurz(info.zuletzt)}` : \"\"}",
      "von dir ${info.mails}× angeschrieben${info.zuletzt ? `, zuletzt am ${datumKurz(info.zuletzt)}` : \"\"}",
      "Mailindex gibt es nicht; die Zahl kommt aus dem Gesendet-Ordner"],
    ["`in AP+ als ${info.rolle ? info.rolle + \" \" : \"\"}„${info.name}“", "`bekannt als ${info.rolle ? info.rolle + \" \" : \"\"}„${info.name}“",
      "kein AP+"],
  ],
  "src/domain/mailLinks.js": [
    ['"Link auf eine nachgemachte oli-Domain"', '"Link auf eine nachgemachte eigene Domain"', "Firmenname im Befundtext"],
  ],
  "server/sperrlisten.js": [
    ['from "../src/domain/spf.js"', 'from "./spf.js"', "Pfad: alles liegt in einem Ordner"],
    ['from "../src/domain/spamhaus.js"', 'from "./spamhaus.js"', "Pfad: alles liegt in einem Ordner"],
  ],
};

/* Einsetzen ohne String.replace (der Ersatztext könnte "$&" enthalten). */
function ersetzen(text, gesucht, ersatz, datei) {
  const erstes = text.indexOf(gesucht);
  if (erstes < 0) throw new Error(`regeln-holen: in ${datei} fehlt der Text: ${gesucht}`);
  if (text.indexOf(gesucht, erstes + 1) >= 0) throw new Error(`regeln-holen: in ${datei} kommt der Text mehrfach vor: ${gesucht}`);
  return text.slice(0, erstes) + ersatz + text.slice(erstes + gesucht.length);
}

rmSync(ziel, { recursive: true, force: true });
mkdirSync(ziel, { recursive: true });
const bericht = [];
for (const datei of DATEIEN) {
  let text = readFileSync(join(quelle, datei), "utf8").replace(/\r\n/g, "\n");
  for (const [gesucht, ersatz, grund] of ERSETZUNGEN[datei] || []) {
    text = ersetzen(text, gesucht, ersatz, datei);
    bericht.push(`${basename(datei)}: ${grund}`);
  }
  const kopf = `/* kopiert aus planungstool (${datei}), nicht hier ändern – scripts/regeln-holen.mjs${ERSETZUNGEN[datei] ? ", mit kleinen Ersetzungen für Gmail" : ""} */\n`;
  writeFileSync(join(ziel, basename(datei)), kopf + text);
}
console.log(`${DATEIEN.length} Dateien nach ${ziel} kopiert.`);
for (const b of bericht) console.log("  ersetzt – " + b);
