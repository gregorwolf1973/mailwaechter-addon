/* kopiert aus planungstool (src/domain/iban.js), nicht hier ändern – scripts/regeln-holen.mjs */
import { sha256Hex } from "./sha256.js";

/* ============================================================
   IBANs in einer Mail – finden, Prüfziffer, Land (19.10.2026)

   Für die Mailprüfung. Die teuerste Masche gegen eine Firma ist die
   „neue Bankverbindung": oft von der ECHTEN Adresse eines Lieferanten,
   dessen Postfach übernommen wurde – dann sind alle Prüfungen am
   Absender grün. Was die Fälschung dann noch verrät, ist das Konto:
   eine litauische IBAN für einen Lieferanten aus Bayern.

   WOHER WIR DAS LAND DES LIEFERANTEN KENNEN: aus `Adresse.Land` im
   AP+-Spiegel. Dort stehen Kfz-Kennzeichen (`D`, `A`, `CH`, `BRU` …),
   IBANs beginnen mit ISO-Codes (`DE`, `AT`, `CH`) – daher die Tabelle
   `KFZ_ZU_ISO`. Ein Kennzeichen, das darin fehlt, wird nicht
   verglichen; lieber kein Befund als ein falscher.

   Die IBANs selbst des Lieferanten stehen NICHT im Spiegel (geprüft am
   19.10.2026). Seit dem 28.10.2026 kann die Buchhaltung eine Liste
   hinlegen (server/mailPruefung.js, `MAILPRUEFUNG_IBANS`); der Browser
   bekommt daraus je Domain nur Prüfsummen (`ibanPruefsumme`) und
   vergleicht sie mit der Summe der IBAN in der Mail.

   REIN UND TESTBAR: Text hinein, Ergebnis heraus.
   ============================================================ */

/* Die Prüfsumme, unter der eine IBAN zwischen Server und Browser
   verglichen wird – gekürzt, eine Kontonummer geht so nicht hinaus.
   Server und Browser müssen sie GLEICH bilden. */
export const ibanPruefsumme = (iban) =>
  sha256Hex("oli-iban:" + String(iban || "").replace(/\s+/g, "").toUpperCase()).slice(0, 16);

/* Länge der IBAN je Land (ISO 13616, SWIFT-Register). */
export const IBAN_LAENGE = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24,
  SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/* Kfz-Kennzeichen (AP+) → ISO. Nur, wo beides abweicht; gleiche Codes
   (`CH`, `GB`, `PL` …) gehen unverändert durch. */
export const KFZ_ZU_ISO = {
  D: "DE", A: "AT", F: "FR", B: "BE", H: "HU", I: "IT", E: "ES", S: "SE", P: "PT", L: "LU", N: "NO", M: "MT",
  FIN: "FI", IRL: "IE", SLO: "SI", EST: "EE", FL: "LI", GBZ: "GI", AND: "AD", RSM: "SM", MC: "MC", V: "VA",
  SRB: "RS", BIH: "BA", MNE: "ME", NMK: "MK", MK: "MK", AL: "AL", MD: "MD", BY: "BY", UA: "UA", RUS: "RU",
  TR: "TR", IL: "IL", ET: "EG", KSA: "SA", UAE: "AE", Q: "QA", KWT: "KW", BRN: "BH", HKJ: "JO", RL: "LB",
  TN: "TN", USA: "US", CDN: "CA", MEX: "MX", BR: "BR", RA: "AR", AUS: "AU", NZ: "NZ", IND: "IN", ZA: "ZA",
  J: "JP", ROK: "KR", CHN: "CN", T: "TH", SGP: "SG", MAL: "MY", RI: "ID", RP: "PH", YV: "VE", IR: "IR",
  PK: "PK", KZ: "KZ", GE: "GE", AZ: "AZ", RO: "RO", BG: "BG", HR: "HR", CZ: "CZ", SK: "SK", LT: "LT",
  LV: "LV", DK: "DK", NL: "NL", GR: "GR", CY: "CY", IS: "IS", CH: "CH", GB: "GB", PL: "PL", MA: "MA", DZ: "DZ",
};
export const isoAusKfz = (kfz) => {
  const k = String(kfz || "").trim().toUpperCase();
  return KFZ_ZU_ISO[k] || "";
};

const LANDNAME = {
  DE: "Deutschland", AT: "Österreich", CH: "der Schweiz", FR: "Frankreich", IT: "Italien", ES: "Spanien",
  NL: "den Niederlanden", BE: "Belgien", LU: "Luxemburg", GB: "Großbritannien", IE: "Irland", PL: "Polen",
  CZ: "Tschechien", SK: "der Slowakei", HU: "Ungarn", SI: "Slowenien", HR: "Kroatien", RO: "Rumänien",
  BG: "Bulgarien", GR: "Griechenland", CY: "Zypern", MT: "Malta", PT: "Portugal", DK: "Dänemark", SE: "Schweden",
  NO: "Norwegen", FI: "Finnland", EE: "Estland", LV: "Lettland", LT: "Litauen", TR: "der Türkei", UA: "der Ukraine",
  RU: "Russland", RS: "Serbien", BA: "Bosnien", LI: "Liechtenstein", IS: "Island", IL: "Israel", AE: "den Emiraten",
  SA: "Saudi-Arabien", QA: "Katar", EG: "Ägypten", US: "den USA", CA: "Kanada", BR: "Brasilien", MX: "Mexiko",
  CN: "China", IN: "Indien", AU: "Australien", ZA: "Südafrika", GE: "Georgien", MD: "Moldau", BY: "Belarus",
};
export const landName = (iso) => (LANDNAME[iso] ? `${LANDNAME[iso]} (${iso})` : iso);

/* Die Prüfziffer nach ISO 7064 (mod 97 = 1). Gerechnet in Stücken,
   weil die Zahl für einen Number-Wert zu lang ist. */
export function ibanGueltig(iban) {
  const s = String(iban || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s) || IBAN_LAENGE[s.slice(0, 2)] !== s.length) return false;
  const umgestellt = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const c of umgestellt) {
    const wert = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const z of wert) rest = (rest * 10 + Number(z)) % 97;
  }
  return rest === 1;
}

/* In Vierergruppen, wie man sie liest und vorliest. */
export const ibanLesbar = (iban) => String(iban || "").replace(/(.{4})/g, "$1 ").trim();

/* ------------------------------------------------------------------
   Alle IBANs im Text: [{ iban, land, gueltig }].

   Gelesen wird ab „Ländercode + zwei Ziffern", Leerzeichen dazwischen
   sind erlaubt, abgeschnitten wird auf die Länge des Landes – so frisst
   ein nachfolgendes „BIC COBADEFFXXX" nichts an. Eine Fundstelle mit
   falscher Prüfziffer zählt nur, wenn sie wie eine IBAN aussieht
   (überwiegend Ziffern): sonst wäre jedes großgeschriebene Wort mit
   zwei Ziffern dahinter ein Verdacht.
   ------------------------------------------------------------------ */
export function ibansAus(text) {
  const raus = [];
  const gesehen = new Set();
  const muster = /\b([A-Z]{2})(\d{2})((?:[ \u00a0]?[A-Z0-9]){10,34})/gi;
  for (const m of String(text || "").slice(0, 200000).matchAll(muster)) {
    const land = m[1].toUpperCase();
    const laenge = IBAN_LAENGE[land];
    if (!laenge) continue;
    const zeichen = (m[1] + m[2] + m[3]).replace(/[ \u00a0]/g, "").toUpperCase();
    if (zeichen.length < laenge) continue;
    const iban = zeichen.slice(0, laenge);
    if (gesehen.has(iban)) continue;
    const gueltig = ibanGueltig(iban);
    const ziffern = (iban.slice(4).match(/\d/g) || []).length;
    if (!gueltig && ziffern < (laenge - 4) * 0.6) continue;
    gesehen.add(iban);
    raus.push({ iban, land, gueltig });
    if (raus.length >= 20) break;
  }
  return raus;
}
