import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { optionenLesen } from "./optionen.js";
import { log, logStufe, geheimnis } from "./log.js";
import { Bekannte } from "./bekannte.js";
import { Protokoll } from "./protokoll.js";
import { netzAbfragen } from "./umfeld.js";
import { Waechter } from "./waechter.js";
import { handlerBauen } from "./api.js";

/* Mailwächter – Einstieg. Optionen aus /data/options.json, Daten in /data
   (lokal: DATA_DIR und OPTIONS_FILE setzen). */
const VERSION = "0.2.0";
const dataDir = process.env.DATA_DIR || "/data";
const port = Number(process.env.PORT || 8099);

const optionen = optionenLesen();
logStufe(optionen.logLevel);
geheimnis(optionen.appPasswort);
mkdirSync(dataDir, { recursive: true });

const protokoll = new Protokoll(dataDir);
const bekannte = new Bekannte(dataDir);
let waechter = null;

if (optionen.gmailAdresse && optionen.appPasswort) {
  waechter = new Waechter({ optionen, dataDir, bekannte, protokoll, netz: netzAbfragen(optionen) });
  waechter.laufen().catch((e) => log.error("Wächter beendet:", e));
} else {
  log.warning("Gmail-Adresse oder App-Passwort fehlt – bitte in den Add-on-Optionen eintragen. Es wird nichts überwacht.");
}
if (optionen.nurMelden) log.info("Modus nur_melden: es wird nichts verschoben oder beschriftet");

/* Protokoll täglich aufräumen (älter als 90 Tage) */
setInterval(() => protokoll.aufraeumen(), 24 * 3600_000).unref();

const server = createServer(handlerBauen({ optionen, waechter, protokoll, bekannte, version: VERSION }));
server.listen(port, "0.0.0.0", () => log.info(`Oberfläche auf Port ${port}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { if (waechter) waechter.stopp = true; server.close(); setTimeout(() => process.exit(0), 500); });
}
