import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Waechter, aktionFuer } from "../mailwaechter/app/waechter.js";
import { Bekannte } from "../mailwaechter/app/bekannte.js";
import { Protokoll } from "../mailwaechter/app/protokoll.js";
import { optionenNormalisieren } from "../mailwaechter/app/optionen.js";
import { melden } from "../mailwaechter/app/benachrichtigung.js";

const eml = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}.eml`, import.meta.url)));

/* Eine Attrappe für imapflow: hält Mails je Ordner und merkt sich die Aufrufe */
class AttrappeClient extends EventEmitter {
  constructor(inbox, uidNext) {
    super();
    this.ordner = { INBOX: inbox, "[Gmail]/Sent Mail": [] };
    this.mailbox = { uidNext, uidValidity: 7n };
    this.aufrufe = [];
    this.nextUid = 100;
  }
  async list() { return Object.keys(this.ordner).map((path) => ({ path, specialUse: path.includes("Sent") ? "\\Sent" : undefined })); }
  async mailboxCreate(name) { this.aufrufe.push(["create", name]); this.ordner[name] = []; }
  async mailboxOpen() {}
  async getMailboxLock(pfad) { this.offen = pfad; return { release() {} }; }
  async search(abfrage) {
    const mails = this.ordner[this.offen] || [];
    if (abfrage.emailId) return mails.filter((m) => m.emailId === abfrage.emailId).map((m) => m.uid);
    if (abfrage.all) return mails.map((m) => m.uid);
    const von = Number(String(abfrage.uid).split(":")[0]);
    const alle = mails.map((m) => m.uid);
    return alle.filter((u) => u >= von).length ? alle.filter((u) => u >= von) : alle.slice(-1);   /* wie IMAP: "N:*" liefert immer die letzte */
  }
  async fetchOne(uid) {
    const m = this.ordner[this.offen].find((x) => x.uid === uid);
    return m && { uid, source: m.source, emailId: m.emailId, envelope: { subject: m.betreff, from: [{ name: m.vonName, address: m.vonAdresse }] } };
  }
  async messageMove(uids, ziel) {
    this.aufrufe.push(["move", [].concat(uids), ziel]);
    const quelle = this.ordner[this.offen];
    for (const u of [].concat(uids)) {
      const i = quelle.findIndex((m) => m.uid === u);
      if (i >= 0) this.ordner[ziel].push({ ...quelle.splice(i, 1)[0], uid: this.nextUid++ });
    }
  }
  async messageCopy(uids, ziel) {
    this.aufrufe.push(["copy", [].concat(uids), ziel]);
    const m = this.ordner[this.offen].find((x) => x.uid === [].concat(uids)[0]);
    this.ordner[ziel].push({ ...m, uid: this.nextUid++ });
  }
  async messageDelete(uids) {
    this.aufrufe.push(["delete", [].concat(uids), this.offen]);
    this.ordner[this.offen] = this.ordner[this.offen].filter((m) => !uids.includes(m.uid));
  }
}

const mailEintrag = (uid, datei, vonAdresse = "x@y.example") => ({ uid, emailId: "gm" + uid, source: eml(datei), betreff: datei, vonName: datei, vonAdresse });

function aufbau(optionenRoh, mails, uidNext) {
  const dir = mkdtempSync(join(tmpdir(), "mw-"));
  const optionen = optionenNormalisieren({ gmail_adresse: "g@gmail.example", app_passwort: "geheim-geheim", ...optionenRoh });
  const client = new AttrappeClient(mails, uidNext);
  const gesendet = [];
  const holen = async (url, opt) => { gesendet.push({ url, opt }); return { ok: true, status: 200 }; };
  const w = new Waechter({ optionen, dataDir: dir, bekannte: new Bekannte(dir), protokoll: new Protokoll(dir), holen, clientFabrik: () => client });
  w.client = client;
  return { w, client, gesendet, dir };
}

test("aktionFuer: rot verschiebt, gelb beschriftet, nur_melden nichts", () => {
  assert.equal(aktionFuer("rot", false), "verschoben");
  assert.equal(aktionFuer("gelb", false), "beschriftet");
  assert.equal(aktionFuer("gruen", false), "keine");
  assert.equal(aktionFuer("rot", true), "nur gemeldet");
});

test("erster Start fasst nichts Altes an", async () => {
  const { w, client } = aufbau({}, [mailEintrag(5, "dmarc-fail"), mailEintrag(6, "dmarc-fail")], 7);
  await w.neueVerarbeiten();
  assert.equal(w.zustand.lastUid, 6);
  assert.deepEqual(client.aufrufe, []);
  assert.equal(w.protokoll.eintraege.length, 0);
});

test("rot: Label Gefahr angelegt, Mail aus INBOX dorthin verschoben, Meldung gesendet", async () => {
  const { w, client, gesendet } = aufbau({ benachrichtigung: "notify.mobile_app_xyz" }, [], 7);
  process.env.SUPERVISOR_TOKEN = "t";
  await w.neueVerarbeiten();                                   /* setzt lastUid = 6 */
  client.ordner.INBOX.push(mailEintrag(7, "dmarc-fail"));
  await w.neueVerarbeiten();
  assert.deepEqual(client.aufrufe[0], ["create", "Gefahr"]);
  assert.deepEqual(client.aufrufe[1], ["move", [7], "Gefahr"]);
  assert.equal(client.ordner.INBOX.length, 0);
  assert.equal(client.ordner.Gefahr.length, 1);
  const e = w.protokoll.eintraege.at(-1);
  assert.equal(e.stufe, "rot");
  assert.equal(e.aktion, "verschoben");
  assert.equal(e.ort, "gefahr");
  assert.equal(w.zustand.lastUid, 7);
  assert.equal(gesendet.length, 1);
  assert.match(gesendet[0].url, /services\/notify\/mobile_app_xyz$/);
  assert.match(JSON.parse(gesendet[0].opt.body).message, /dmarc-fail.*DMARC fehlgeschlagen/s);
});

test("gelb: bleibt in INBOX, zusätzlich Label Prüfen (COPY); grün: nichts", async () => {
  const { w, client } = aufbau({}, [], 7);
  await w.neueVerarbeiten();
  client.ordner.INBOX.push(mailEintrag(7, "unbekannt-anmeldung"), mailEintrag(8, "harmlos"));
  await w.neueVerarbeiten();
  assert.deepEqual(client.aufrufe, [["create", "Prüfen"], ["copy", [7], "Prüfen"]]);
  assert.equal(client.ordner.INBOX.length, 2);
  assert.deepEqual(w.protokoll.eintraege.map((e) => [e.stufe, e.aktion]), [["gelb", "beschriftet"], ["gruen", "keine"]]);
});

test("nur_melden: nichts verschoben, nur protokolliert", async () => {
  const { w, client } = aufbau({ nur_melden: true }, [], 7);
  await w.neueVerarbeiten();
  client.ordner.INBOX.push(mailEintrag(7, "dmarc-fail"));
  await w.neueVerarbeiten();
  assert.deepEqual(client.aufrufe, []);
  assert.equal(client.ordner.INBOX.length, 1);
  assert.equal(w.protokoll.eintraege.at(-1).aktion, "nur gemeldet");
});

test("Testlauf: prüft die letzten Mails, verschiebt nie", async () => {
  const { w, client } = aufbau({}, [mailEintrag(1, "dmarc-fail"), mailEintrag(2, "harmlos")], 3);
  const n = await w.testlauf(50);
  assert.equal(n, 2);
  assert.deepEqual(client.aufrufe, []);
  assert.ok(w.protokoll.eintraege.every((e) => e.test));
  assert.equal(w.protokoll.eintraege[0].aktion, "nur gemeldet (Test)");
});

test("Zurückholen: Mail zurück in INBOX, Domain künftig bekannt, nicht erneut geprüft", async () => {
  const { w, client } = aufbau({}, [], 7);
  await w.neueVerarbeiten();
  client.ordner.INBOX.push(mailEintrag(7, "dmarc-fail", "info@sparkasse-beispiel.example"));
  await w.neueVerarbeiten();
  const e = w.protokoll.eintraege.at(-1);
  e.von = "Sparkasse <info@sparkasse-beispiel.example>";
  const r = await w.zurueckholen(e.id);
  assert.equal(r.domainGemerkt, "sparkasse-beispiel.example");
  assert.equal(client.ordner.INBOX.length, 1);
  assert.equal(client.ordner.Gefahr.length, 0);
  assert.ok(w.bekannte.alsMap(w.optionen).has("sparkasse-beispiel.example"));
  assert.equal(w.protokoll.eintraege.at(-1).zurueckgeholt, true);
  /* die zurückgeholte Mail bekommt eine neue UID – sie darf nicht noch einmal verschoben werden */
  const neueUid = client.ordner.INBOX[0].uid;
  await w.neueVerarbeiten();
  assert.equal(client.ordner.INBOX.length, 1);
  assert.equal(client.ordner.INBOX[0].uid, neueUid);
});

test("Gesendet-Ordner: nur Empfänger-Domains, ohne Freemail und eigene Adresse", () => {
  const je = Bekannte.zaehlen([
    { to: [{ address: "a@lieferant.example" }, { address: "b@gmail.com" }], cc: [{ address: "g@gmail.example" }], datum: "2026-05-01" },
    { to: [{ address: "c@lieferant.example" }], datum: "2026-06-01" },
  ], { eigeneAdresse: "g@gmail.example" });
  assert.deepEqual(Object.keys(je), ["lieferant.example"]);
  assert.equal(je["lieferant.example"].mails, 2);
});

test("Benachrichtigung: gelb nur bei melden_bei=gelb, App-Passwort nie im Text", async () => {
  const gesendet = [];
  const holen = async (u, o) => { gesendet.push(o); return { ok: true, status: 200 }; };
  const o = optionenNormalisieren({ benachrichtigung: "notify.x" });
  process.env.SUPERVISOR_TOKEN = "t";
  assert.equal(await melden(o, { von: "a", betreff: "b", stufe: "gelb", grund: "g" }, { holen }), false);
  assert.equal(await melden({ ...o, meldenBei: "gelb" }, { von: "a", betreff: "b", stufe: "gelb", grund: "g" }, { holen }), true);
  assert.equal(gesendet.length, 1);
});

test("Optionen: Leerzeichen im App-Passwort fallen weg, Standardwerte", () => {
  const o = optionenNormalisieren({ app_passwort: "abcd efgh ijkl mnop" });
  assert.equal(o.appPasswort, "abcdefghijklmnop");
  assert.equal(o.rdap, true);
  assert.equal(o.sperrlisten, true);
  assert.equal(o.nurMelden, false);
  assert.equal(o.meldenBei, "rot");
});

import { createServer } from "node:http";
import { handlerBauen } from "../mailwaechter/app/api.js";

test("Protokoll speichert den Bericht (auch im Testlauf), Fehler mit Fehlertext", async () => {
  const { w } = aufbau({}, [mailEintrag(1, "dmarc-fail"), mailEintrag(2, "harmlos")], 3);
  await w.testlauf(50);
  for (const e of w.protokoll.eintraege) {
    assert.ok(e.bericht?.befunde?.length, "Bericht fehlt");
    assert.ok(e.gruende.every((g) => g.stufe !== "gruen"), "gruende ohne grün bleibt");
    assert.ok(!("lesetext" in e.bericht));
  }
  assert.ok(w.protokoll.eintraege[1].bericht.befunde.some((b) => b.stufe === "gruen"));
  const { w: w2 } = aufbau({}, [mailEintrag(1, "dmarc-fail")], 2);
  w2.client.ordner.INBOX[0].source = Buffer.alloc(0);
  w2.client.offen = "INBOX";
  const f = await w2.mailVerarbeiten(w2.client, 1, { test: true }).catch((e) => e);
  assert.equal(f.stufe, "fehler");
  assert.match(f.bericht.fehler, /nicht lesbar/);
});

test("/api/eintraege ohne Bericht, /api/eintrag liefert ihn (200/400/404)", async () => {
  const { w } = aufbau({}, [mailEintrag(1, "dmarc-fail")], 2);
  await w.testlauf(50);
  const server = createServer(handlerBauen({ optionen: w.optionen, waechter: null, protokoll: w.protokoll, bekannte: { domains: {}, stand: null } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  try {
    const liste = await (await fetch(basis + "/api/eintraege")).json();
    assert.equal(liste.eintraege.length, 1);
    assert.ok(!("bericht" in liste.eintraege[0]));
    assert.equal(liste.eintraege[0].hatBericht, true);
    const id = liste.eintraege[0].id;
    const r = await fetch(basis + "/api/eintrag?id=" + id);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.eintrag.id, id);
    assert.equal(j.eintrag.bericht.stufe, "rot");
    assert.equal((await fetch(basis + "/api/eintrag?id=00000000-0000-0000-0000-000000000000")).status, 404);
    assert.equal((await fetch(basis + "/api/eintrag?id=../x")).status, 400);
    assert.equal((await fetch(basis + "/api/eintrag")).status, 400);
  } finally { server.close(); }
});
