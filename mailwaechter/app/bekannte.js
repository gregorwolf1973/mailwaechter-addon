import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { basisDomain, istFreemail } from "./regeln/mailDomain.js";

/* ============================================================
   Bekannte Absender: die Domains, an die Gregor selbst geschrieben hat.

   Gelesen wird NUR die Hülle (Envelope To/Cc) der Mails im Gesendet-Ordner
   der letzten 2 Jahre – nie ein Text. Gespeichert wird je Basisdomain, wie
   oft und wann zuletzt (bekannte.json in /data), nicht die Adresse selbst.
   Freemail fällt heraus (wie im Planungstool: "bekannter Absender" gmail.com
   wäre gelogen).

   Dazu kommen
     - die Option `bekannte_domains`,
     - Domains, die per "Zurückholen" freigegeben wurden (zusatz).
   ============================================================ */

const ZWEI_JAHRE_MS = 2 * 365 * 24 * 3600_000;

export class Bekannte {
  constructor(dataDir) {
    this.datei = join(dataDir, "bekannte.json");
    this.stand = null;       // ISO-Zeit der letzten Auswertung
    this.domains = {};       // d → { mails, zuletzt }
    this.zusatz = {};        // d → ISO-Zeit (zurückgeholt)
    try {
      if (existsSync(this.datei)) {
        const j = JSON.parse(readFileSync(this.datei, "utf8"));
        this.stand = j.stand || null;
        this.domains = j.domains || {};
        this.zusatz = j.zusatz || {};
      }
    } catch { /* kaputte Datei: neu aufbauen */ }
  }

  speichern() {
    const tmp = this.datei + ".tmp";
    writeFileSync(tmp, JSON.stringify({ stand: this.stand, domains: this.domains, zusatz: this.zusatz }));
    renameSync(tmp, this.datei);
  }

  veraltet(maxStunden = 24) {
    return !this.stand || Date.now() - new Date(this.stand).getTime() > maxStunden * 3600_000;
  }

  /* Die Map, die mailPruefen() als `bekannte` erwartet */
  alsMap(optionen) {
    const m = new Map();
    for (const [d, w] of Object.entries(this.domains)) m.set(d, { mails: w.mails, zuletzt: w.zuletzt, name: "", laender: [], rolle: "" });
    for (const d of optionen.bekannteDomains || []) {
      const b = basisDomain(d);
      if (b) m.set(b, { ...(m.get(b) || { mails: 0, zuletzt: null, laender: [], rolle: "" }), name: "Eintrag in den Optionen" });
    }
    for (const d of Object.keys(this.zusatz)) {
      if (!m.has(d)) m.set(d, { mails: 0, zuletzt: null, name: "von dir freigegeben", laender: [], rolle: "" });
    }
    return m;
  }

  merkeFreigabe(domain) {
    const b = basisDomain(domain);
    if (!b || istFreemail(b)) return false;
    this.zusatz[b] = new Date().toISOString();
    this.speichern();
    return true;
  }

  /* Aus Umschlägen (Envelope) die Empfängerdomains zählen */
  static zaehlen(umschlaege, { eigeneAdresse = "", eigeneDomains = [] } = {}) {
    const je = {};
    for (const u of umschlaege) {
      const zeit = u.datum ? new Date(u.datum).toISOString() : null;
      for (const a of [...(u.to || []), ...(u.cc || [])]) {
        const adr = String(a?.address || "").toLowerCase();
        if (!adr.includes("@") || adr === eigeneAdresse) continue;
        const d = basisDomain(adr.split("@").pop());
        if (!d || !d.includes(".") || istFreemail(d) || eigeneDomains.some((e) => basisDomain(e) === d)) continue;
        const alt = je[d] || { mails: 0, zuletzt: null };
        je[d] = { mails: alt.mails + 1, zuletzt: zeit && (!alt.zuletzt || zeit > alt.zuletzt) ? zeit : alt.zuletzt };
      }
    }
    return je;
  }

  /* Den Gesendet-Ordner lesen. `client` ist ein imapflow-Client. */
  async ausGesendetLesen(client, optionen) {
    const ordner = (await client.list()).find((o) => o.specialUse === "\\Sent");
    if (!ordner) throw new Error("Kein Gesendet-Ordner (\\Sent) gefunden");
    const seit = new Date(Date.now() - ZWEI_JAHRE_MS);
    const umschlaege = [];
    const sperre = await client.getMailboxLock(ordner.path, { readOnly: true });
    try {
      const uids = (await client.search({ since: seit }, { uid: true })) || [];
      for (let i = 0; i < uids.length; i += 500) {
        const stueck = uids.slice(i, i + 500).join(",");
        for await (const m of client.fetch(stueck, { envelope: true }, { uid: true })) {
          umschlaege.push({ to: m.envelope?.to, cc: m.envelope?.cc, datum: m.envelope?.date });
        }
      }
    } finally {
      sperre.release();
    }
    this.domains = Bekannte.zaehlen(umschlaege, { eigeneAdresse: optionen.gmailAdresse, eigeneDomains: optionen.eigeneDomains });
    this.stand = new Date().toISOString();
    this.speichern();
    return { ordner: ordner.path, mails: umschlaege.length, domains: Object.keys(this.domains).length };
  }
}
