import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/* ============================================================
   Das Protokoll der geprüften Mails: JSON-Zeilen in /data/protokoll.jsonl.
   Klein gehalten – älter als 90 Tage wird gelöscht (beim Start und
   täglich), höchstens 5000 Einträge. Je Zeile:

     { id, zeit, von, betreff, stufe, gruende:[{stufe,titel,text}], bericht (ab 0.2.0, siehe berichtKompakt),
       aktion, ort, gmailId, test, zurueckgeholt }

   `aktion`: "verschoben", "beschriftet", "nur gemeldet", "keine", "Fehler".
   `ort`: "gefahr" | "pruefen" | "" – wo die Mail jetzt liegt (für Zurückholen).
   Nur Absender, Betreff, Befundtexte und Link-/Anhangnamen – kein Mailtext.
   ============================================================ */

const TAGE = 90;
const MAX = 5000;

export class Protokoll {
  constructor(dataDir) {
    this.datei = join(dataDir, "protokoll.jsonl");
    this.eintraege = [];
    if (existsSync(this.datei)) {
      for (const z of readFileSync(this.datei, "utf8").split("\n")) {
        if (!z.trim()) continue;
        try { this.eintraege.push(JSON.parse(z)); } catch { /* kaputte Zeile überspringen */ }
      }
    }
    this.aufraeumen();
  }

  aufraeumen(jetzt = Date.now()) {
    const grenze = jetzt - TAGE * 24 * 3600_000;
    const vorher = this.eintraege.length;
    this.eintraege = this.eintraege.filter((e) => new Date(e.zeit).getTime() >= grenze).slice(-MAX);
    if (this.eintraege.length !== vorher) this.neuSchreiben();
  }

  neuSchreiben() {
    const tmp = this.datei + ".tmp";
    writeFileSync(tmp, this.eintraege.map((e) => JSON.stringify(e)).join("\n") + (this.eintraege.length ? "\n" : ""));
    renameSync(tmp, this.datei);
  }

  hinzufuegen(e) {
    const eintrag = { id: randomUUID(), zeit: new Date().toISOString(), zurueckgeholt: false, test: false, ort: "", ...e };
    this.eintraege.push(eintrag);
    appendFileSync(this.datei, JSON.stringify(eintrag) + "\n");
    if (this.eintraege.length > MAX) this.aufraeumen();
    return eintrag;
  }

  aendern(id, felder) {
    const e = this.eintraege.find((x) => x.id === id);
    if (!e) return null;
    Object.assign(e, felder);
    this.neuSchreiben();
    return e;
  }

  /* Wurde diese Gmail-Nachricht schon geprüft (nicht im Test)? */
  gesehen(gmailId) {
    return !!gmailId && this.eintraege.some((e) => e.gmailId === gmailId && !e.test);
  }

  finden(id) {
    return this.eintraege.find((e) => e.id === id) || null;
  }

  liste(filter = "alle", grenze = 500) {
    const f = filter === "rot" || filter === "gelb" ? (e) => e.stufe === filter : () => true;
    return this.eintraege.filter(f).slice(-grenze).reverse();
  }
}
