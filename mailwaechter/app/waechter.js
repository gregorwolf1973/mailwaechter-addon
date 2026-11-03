import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { pruefeMail, wichtigsterGrund } from "./pruefen.js";
import { melden } from "./benachrichtigung.js";
import { log } from "./log.js";

/* ============================================================
   Der Wächter: hält eine IMAP-Verbindung zu Gmail offen (IDLE auf INBOX),
   prüft jede NEUE Mail und handelt nach dem Ergebnis:

     rot   → Label "Gefahr" (anlegen, falls es fehlt), aus INBOX entfernen
             (MOVE nach "Gefahr")
     gelb  → bleibt in INBOX, zusätzlich Label "Prüfen" (COPY in den Ordner)
     sonst → nichts
     nur_melden → nichts verschieben, nur protokollieren

   NEU heißt: UID größer als die zuletzt gesehene (zustand.json in /data).
   Beim allerersten Start (oder wenn Gmail die UIDVALIDITY ändert) wird die
   letzte UID einfach übernommen – nichts Altes wird angefasst.

   Alle Befehle laufen nacheinander in einer Warteschlange (`aufgabe`):
   imapflow erlaubt nur ein ausgewähltes Postfach zugleich. Nach jeder
   Aufgabe wird INBOX wieder ausgewählt, damit IDLE dort weiterläuft.
   Das Passwort steht nur in der Verbindung, in keinem Protokoll.
   ============================================================ */

export const LABEL_ROT = "Gefahr";
export const LABEL_GELB = "Prüfen";

/* Was geschieht mit der Mail? – reine Entscheidung, gut zu testen */
export function aktionFuer(stufe, nurMelden) {
  if (stufe !== "rot" && stufe !== "gelb") return "keine";
  return nurMelden ? "nur gemeldet" : stufe === "rot" ? "verschoben" : "beschriftet";
}

export function imapClientBauen(optionen) {
  return new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: optionen.gmailAdresse, pass: optionen.appPasswort },
    logger: false,
    maxIdleTime: 5 * 60_000,
  });
}

export class Waechter {
  constructor({ optionen, dataDir, bekannte, protokoll, netz = null, clientFabrik = imapClientBauen, holen = fetch, wartezeit = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.optionen = optionen;
    this.bekannte = bekannte;
    this.protokoll = protokoll;
    this.netz = netz;
    this.clientFabrik = clientFabrik;
    this.holen = holen;
    this.warte = wartezeit;
    this.zustandDatei = join(dataDir, "zustand.json");
    this.zustand = { uidValidity: null, lastUid: null, freigegeben: [] };
    try { if (existsSync(this.zustandDatei)) Object.assign(this.zustand, JSON.parse(readFileSync(this.zustandDatei, "utf8"))); } catch { /* neu */ }
    this.client = null;
    this.kette = Promise.resolve();
    this.ordnerBekannt = new Set();
    this.status = { verbunden: false, seit: null, fehler: "", naechsterVersuch: null, letztePruefung: null, geprueft: 0, gesendetStand: null };
    this.stopp = false;
  }

  zustandSpeichern() {
    const tmp = this.zustandDatei + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.zustand));
    renameSync(tmp, this.zustandDatei);
  }

  /* Aufgaben nacheinander */
  aufgabe(fn) {
    const lauf = this.kette.then(fn, fn);
    this.kette = lauf.catch(() => {});
    return lauf;
  }

  /* Label (= Gmail-Ordner) anlegen, falls es fehlt */
  async ordnerSichern(client, name) {
    if (this.ordnerBekannt.has(name)) return;
    const alle = await client.list();
    if (!alle.some((o) => o.path === name)) {
      await client.mailboxCreate(name);
      log.info(`Label „${name}“ angelegt`);
    }
    this.ordnerBekannt.add(name);
  }

  async inboxWieder(client) {
    try { await client.mailboxOpen("INBOX"); } catch (e) { log.debug("INBOX nicht wieder geöffnet:", e); }
  }

  /* Eine Mail holen, prüfen, handeln, protokollieren. Im Test (test: true)
     wird NIE verschoben oder beschriftet und nichts gemeldet. */
  async mailVerarbeiten(client, uid, { test = false } = {}) {
    const m = await client.fetchOne(uid, { uid: true, source: true, envelope: true, emailId: true }, { uid: true });
    if (!m) return null;
    const gmailId = m.emailId ? String(m.emailId) : "";
    if (!test && (this.zustand.freigegeben.includes(gmailId) || this.protokoll.gesehen(gmailId))) return null;
    const von = (m.envelope?.from || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
    const betreff = m.envelope?.subject || "";
    let ergebnis;
    try {
      ergebnis = await pruefeMail(m.source, { optionen: this.optionen, bekannte: this.bekannte.alsMap(this.optionen), netz: this.netz });
    } catch (e) {
      ergebnis = { stufe: "fehler", fehler: String(e?.message || e), gruende: [] };
    }
    if (ergebnis.stufe === "fehler") {
      log.warning(`Prüfung gescheitert (UID ${uid}): ${ergebnis.fehler}`);
      return this.protokoll.hinzufuegen({ von, betreff, stufe: "fehler", gruende: [{ stufe: "info", titel: ergebnis.fehler, text: "" }], aktion: "Fehler", gmailId, test });
    }
    let aktion = test ? (["rot", "gelb"].includes(ergebnis.stufe) ? "nur gemeldet (Test)" : "keine") : aktionFuer(ergebnis.stufe, this.optionen.nurMelden);
    let ort = "";
    if (!test) {
      try {
        if (aktion === "verschoben") {
          await this.ordnerSichern(client, LABEL_ROT);
          await client.messageMove(uid, LABEL_ROT, { uid: true });
          ort = "gefahr";
        } else if (aktion === "beschriftet") {
          await this.ordnerSichern(client, LABEL_GELB);
          await client.messageCopy(uid, LABEL_GELB, { uid: true });
          ort = "pruefen";
        }
      } catch (e) {
        log.error(`Aktion „${aktion}“ gescheitert (UID ${uid}):`, e);
        aktion = "Fehler";
      }
    }
    const grund = wichtigsterGrund(ergebnis.gruende, ergebnis.stufe);
    log.info(`${ergebnis.stufe.toUpperCase()} – ${von} – ${betreff} – ${aktion}${grund ? ` – ${grund}` : ""}`);
    const eintrag = this.protokoll.hinzufuegen({ von, betreff, stufe: ergebnis.stufe, gruende: ergebnis.gruende.map(({ stufe, titel, text }) => ({ stufe, titel, text })), aktion, ort, gmailId, test });
    this.status.geprueft++;
    this.status.letztePruefung = eintrag.zeit;
    if (!test) await melden(this.optionen, { von, betreff, stufe: ergebnis.stufe, grund, aktion }, { holen: this.holen });
    return eintrag;
  }

  /* Alles nach der zuletzt gesehenen UID */
  neueVerarbeiten() {
    return this.aufgabe(async () => {
      const client = this.client;
      if (!client) return;
      const sperre = await client.getMailboxLock("INBOX");
      try {
        const box = client.mailbox;
        const validity = String(box.uidValidity);
        if (this.zustand.lastUid === null || String(this.zustand.uidValidity) !== validity) {
          this.zustand.uidValidity = validity;
          this.zustand.lastUid = (box.uidNext || 1) - 1;
          this.zustandSpeichern();
          log.info(`Start bei UID ${this.zustand.lastUid} – Älteres wird nicht angefasst`);
          return;
        }
        const gefunden = (await client.search({ uid: `${this.zustand.lastUid + 1}:*` }, { uid: true })) || [];
        const neu = gefunden.filter((u) => u > this.zustand.lastUid).sort((a, b) => a - b);
        for (const uid of neu) {
          try { await this.mailVerarbeiten(client, uid); } catch (e) { log.error(`UID ${uid}:`, e); }
          this.zustand.lastUid = uid;
          this.zustand.freigegeben = this.zustand.freigegeben.slice(-500);
          this.zustandSpeichern();
        }
      } finally {
        sperre.release();
      }
    });
  }

  /* Die letzten n Mails prüfen – nur melden, nichts verschieben */
  testlauf(n = 50) {
    return this.aufgabe(async () => {
      const client = this.client;
      if (!client) throw new Error("Keine Verbindung zu Gmail");
      const sperre = await client.getMailboxLock("INBOX");
      let gelaufen = 0;
      try {
        const alle = (await client.search({ all: true }, { uid: true })) || [];
        for (const uid of alle.sort((a, b) => a - b).slice(-n)) {
          try { if (await this.mailVerarbeiten(client, uid, { test: true })) gelaufen++; } catch (e) { log.error(`Test UID ${uid}:`, e); }
        }
      } finally {
        sperre.release();
      }
      return gelaufen;
    });
  }

  /* Aus dem Gesendet-Ordner die bekannten Empfänger neu lesen */
  gesendetLesen() {
    return this.aufgabe(async () => {
      const client = this.client;
      if (!client) return;
      try {
        const r = await this.bekannte.ausGesendetLesen(client, this.optionen);
        this.status.gesendetStand = this.bekannte.stand;
        log.info(`Gesendet („${r.ordner}“): ${r.mails} Mails, ${r.domains} Domains als bekannt gemerkt`);
      } catch (e) {
        log.warning("Gesendet-Ordner nicht gelesen:", e);
      }
      await this.inboxWieder(client);
    });
  }

  /* "Zurückholen": Mail zurück in INBOX, Labels weg, Domain als bekannt merken */
  zurueckholen(id) {
    return this.aufgabe(async () => {
      const e = this.protokoll.eintraege.find((x) => x.id === id);
      if (!e) throw new Error("Eintrag nicht gefunden");
      const client = this.client;
      if (e.ort && !client) throw new Error("Keine Verbindung zu Gmail");
      if (e.ort && e.gmailId) {
        const ordner = e.ort === "gefahr" ? LABEL_ROT : LABEL_GELB;
        const sperre = await client.getMailboxLock(ordner);
        try {
          const uids = (await client.search({ emailId: e.gmailId }, { uid: true })) || [];
          if (uids.length) {
            if (e.ort === "gefahr") await client.messageMove(uids, "INBOX", { uid: true });
            else await client.messageDelete(uids, { uid: true });   /* im Label-Ordner nimmt das nur das Label weg */
          }
        } finally {
          sperre.release();
        }
        await this.inboxWieder(client);
      }
      if (e.gmailId) { this.zustand.freigegeben.push(e.gmailId); this.zustandSpeichern(); }
      const adresse = (e.von.match(/<([^>]+)>/) || [, e.von])[1] || "";
      const domain = adresse.split("@")[1] || "";
      const gemerkt = domain ? this.bekannte.merkeFreigabe(domain) : false;
      this.protokoll.aendern(id, { zurueckgeholt: true, ort: "" });
      log.info(`Zurückgeholt: ${e.von} – ${e.betreff}${gemerkt ? ` (Domain ${domain} künftig bekannt)` : ""}`);
      return { domainGemerkt: gemerkt ? domain : "" };
    });
  }

  /* Eine Verbindung: aufbauen, bedienen, bis sie abbricht. Wirft dann. */
  async verbindungHalten() {
    const client = this.clientFabrik(this.optionen);
    let angestossen = false;
    const anstossen = () => {
      if (angestossen) return;
      angestossen = true;
      setTimeout(() => { angestossen = false; this.neueVerarbeiten().catch((e) => log.error("Verarbeitung:", e)); }, 500);
    };
    const geschlossen = new Promise((_, nein) => {
      client.on("close", () => nein(new Error("Verbindung geschlossen")));
      client.on("error", (e) => log.warning("IMAP-Fehler:", e));
    });
    geschlossen.catch(() => {});
    client.on("exists", anstossen);
    await client.connect();
    this.client = client;
    this.status.verbunden = true;
    this.status.seit = new Date().toISOString();
    this.status.fehler = "";
    log.info("Mit Gmail verbunden");
    await client.mailboxOpen("INBOX");
    if (this.bekannte.veraltet()) await this.gesendetLesen();
    this.status.gesendetStand = this.bekannte.stand;
    await this.neueVerarbeiten();
    await this.inboxWieder(client);
    /* Sicherheitsnetz: alle 5 Minuten nachsehen, stündlich Gesendet auf Alter prüfen */
    const takt = setInterval(() => {
      this.neueVerarbeiten().catch((e) => log.error("Verarbeitung:", e));
      if (this.bekannte.veraltet()) this.gesendetLesen().catch(() => {});
    }, 5 * 60_000);
    try {
      await geschlossen;
    } finally {
      clearInterval(takt);
      this.client = null;
      this.status.verbunden = false;
      try { client.close(); } catch { /* schon zu */ }
    }
  }

  /* Dauerlauf mit Wiederverbinden und Backoff */
  async laufen() {
    let pause = 5_000;
    while (!this.stopp) {
      const start = Date.now();
      try {
        await this.verbindungHalten();
      } catch (e) {
        this.status.fehler = String(e?.message || e);
        log.error("Verbindung:", e);
      }
      if (this.stopp) break;
      pause = Date.now() - start > 120_000 ? 5_000 : Math.min(pause * 2, 300_000);
      this.status.naechsterVersuch = new Date(Date.now() + pause).toISOString();
      log.info(`Neuer Versuch in ${Math.round(pause / 1000)} s`);
      await this.warte(pause);
    }
  }
}
