import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pruefeMail, googleAussage } from "../mailwaechter/app/pruefen.js";
import { optionenNormalisieren } from "../mailwaechter/app/optionen.js";
import { dnsPruefen } from "../mailwaechter/app/umfeld.js";

const eml = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}.eml`, import.meta.url)));
const optionen = optionenNormalisieren({});
const bekannte = new Map([
  ["beispiel-firma.example", { mails: 3, zuletzt: "2026-10-01T00:00:00Z", name: "", laender: [], rolle: "" }],
  ["paypal.com", { mails: 2, zuletzt: null, name: "", laender: [], rolle: "" }],
]);
const titel = (e) => e.gruende.map((g) => `${g.stufe}:${g.titel}`).join(" | ");

test("harmlose Mail eines bekannten Absenders ist grün", async () => {
  const e = await pruefeMail(eml("harmlos"), { optionen, bekannte });
  assert.equal(e.stufe, "gruen", titel(e));
  assert.ok(!e.gruende.some((g) => g.stufe === "rot" || g.stufe === "gelb"));
});

test("PayPal-Phishing mit paypa1-Link und Anzeige ungleich Ziel ist rot", async () => {
  const e = await pruefeMail(eml("paypal-phishing"), { optionen, bekannte });
  assert.equal(e.stufe, "rot", titel(e));
  assert.ok(e.gruende.some((g) => g.stufe === "rot" && /Link zeigt etwas anderes/.test(g.titel)), titel(e));
});

test(".exe im ZIP ist rot", async () => {
  const e = await pruefeMail(eml("zip-exe"), { optionen, bekannte });
  assert.equal(e.stufe, "rot", titel(e));
  assert.ok(e.gruende.some((g) => g.stufe === "rot" && /Programm oder Skript/.test(g.titel)), titel(e));
});

test("dmarc=fail von mx.google.com ist rot", async () => {
  const e = await pruefeMail(eml("dmarc-fail"), { optionen, bekannte });
  assert.equal(e.stufe, "rot", titel(e));
  assert.ok(e.gruende.some((g) => g.stufe === "rot" && /Google: DMARC/.test(g.titel)), titel(e));
});

test("nur der OBERSTE Authentication-Results von Google zählt, ein untergeschobener dmarc=pass nicht", async () => {
  const roh = eml("gefaelschter-kopf");
  const g = googleAussage((await pruefeMail(roh, { optionen, bekannte })).mail.kopf);
  assert.equal(g.dmarc, "fail");
  const e = await pruefeMail(roh, { optionen, bekannte });
  assert.equal(e.stufe, "rot");
});

test("Mail ohne Google-Kopf: kein Google-Befund", async () => {
  const ohne = Buffer.from(eml("harmlos").toString().replace(/^Authentication-Results:.*\r\n/m, "").replace(/^ARC-Authentication-Results:.*\r\n/m, ""));
  const e = await pruefeMail(ohne, { optionen, bekannte });
  assert.ok(!e.gruende.some((g) => /Google/.test(g.titel)));
});

test("unbekannter Absender mit Anmeldeaufforderung ist gelb", async () => {
  const e = await pruefeMail(eml("unbekannt-anmeldung"), { optionen, bekannte });
  assert.equal(e.stufe, "gelb", titel(e));
  assert.ok(e.gruende.some((g) => /Aufforderung zur Anmeldung/.test(g.titel)));
});

test("geschützter Name in fremder Adresse ist rot, mit eigener Domain nicht", async () => {
  const mail = Buffer.from(eml("harmlos").toString().replace("Max Muster <max.muster@beispiel-firma.example>", "Gregor Wolf <gw@fremd-beispiel.example>"));
  const mit = await pruefeMail(mail, { optionen: optionenNormalisieren({ geschuetzte_namen: ["Gregor Wolf"] }), bekannte });
  assert.equal(mit.stufe, "rot", titel(mit));
  assert.ok(mit.gruende.some((g) => /Name eines Kollegen/.test(g.titel)));
  const ohne = await pruefeMail(mail, { optionen, bekannte });
  assert.notEqual(ohne.stufe, "rot", titel(ohne));
});

test("SPF aus dem Netz: Attrappe-Resolver sagt fail → rot, wenn die Domain passt", async () => {
  const resolver = {
    txt: async (n) => (n === "sparkasse-beispiel.example" ? [["v=spf1 ip4:192.0.2.1 -all"]] : n === "_dmarc.sparkasse-beispiel.example" ? [["v=DMARC1; p=reject"]] : []),
    a: async () => ["192.0.2.9"], aaaa: async () => { throw Object.assign(new Error("nodata"), { code: "ENODATA" }); }, mx: async () => [],
  };
  const netz = (a) => dnsPruefen(a, resolver, {});
  const e = await pruefeMail(eml("dmarc-fail"), { optionen, bekannte, netz });
  assert.equal(e.stufe, "rot", titel(e));
  assert.ok(e.gruende.some((g) => /SPF/.test(g.titel)), titel(e));
});
