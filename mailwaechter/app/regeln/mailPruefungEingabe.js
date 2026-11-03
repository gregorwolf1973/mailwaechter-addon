/* kopiert aus planungstool (src/domain/mailPruefungEingabe.js), nicht hier ändern – scripts/regeln-holen.mjs */
import { cfbOeffnen, msgFelder, htmlAus, anhaengeAus, zeitAus } from "./msgLesen.js";
import { emlLesen, emlAnhaenge } from "./emlLesen.js";
import { kopfzeilenZerlegen, kopfErster, adresseZerlegen } from "./mailKopfzeilen.js";

/* ============================================================
   Was in die Mailprüfung hineinkommt – drei Wege, EINE Form (19.10.2026)

   1. `.msg` – aus Outlook gezogen. Die Kopfzeilen, wie sie ankamen,
      stehen in PR_TRANSPORT_MESSAGE_HEADERS (`__substg1.0_007D001F`).
      Gemessen an 40 Mails aus I:\Auftraege hatten 26 sie; den übrigen
      fehlen sie, weil es GESENDETE Mails oder Entwürfe sind – die sind
      nie über einen Eingang gelaufen. Dann ist die Herkunft nicht
      prüfbar, Links, Anhänge und Text aber schon.
   2. `.eml` – Rohtext, Kopfzeilen vorne.
   3. Eingefügte Kopfzeilen – Outlook: Datei › Eigenschaften ›
      „Internetkopfzeilen". Für den Fall, dass das Ziehen nicht geht
      (neues Outlook, Outlook im Browser).

   Die Form: { quelle, kopfText, kopf, von, antwortAn, returnPath,
   betreff, gesendet, text, html, anhaenge } – `anhaenge` mit
   { name, groesse, daten() }. msgLesen.js bleibt dabei UNVERÄNDERT:
   die Mailsuche hängt daran, und ihre gebaute Datei soll nicht wegen
   eines fremden Werkzeugs neu entstehen müssen.
   ============================================================ */

/* Ein Textstrom einer .msg – UTF-16 (001F) oder Windows-1252 (001E). */
function msgText(cfb, kennung) {
  for (const [typ, kodierung] of [["001F", "utf-16le"], ["001E", "windows-1252"]]) {
    const e = cfb.eintraege.find((x) => x.name === `__substg1.0_${kennung}${typ}`);
    if (e) {
      try { return new TextDecoder(kodierung).decode(cfb.strom(e)).split(String.fromCharCode(0))[0]; } catch { return ""; }
    }
  }
  return "";
}

function form({ quelle, kopfText, felder, html, anhaenge }) {
  const kopf = kopfzeilenZerlegen(kopfText);
  const ausKopf = adresseZerlegen(kopfErster(kopf, "From"));
  const von = ausKopf.adresse
    ? ausKopf
    : adresseZerlegen(felder?.vonAdresse ? `"${felder.vonName || ""}" <${felder.vonAdresse}>` : "");
  const antwort = kopfErster(kopf, "Reply-To");
  return {
    quelle,
    kopfText: String(kopfText || ""),
    kopf,
    von,
    vonAnzahl: kopf.filter((z) => z.name.toLowerCase() === "from").length,
    antwortAn: antwort ? adresseZerlegen(antwort) : null,
    returnPath: adresseZerlegen(kopfErster(kopf, "Return-Path")).adresse,
    betreff: felder?.betreff || kopfErster(kopf, "Subject"),
    gesendet: felder?.gesendet || "",
    text: felder?.text || "",
    html: html || "",
    anhaenge: anhaenge || [],
  };
}

export function pruefMailAusMsg(bytes) {
  const cfb = cfbOeffnen(bytes);
  if (!cfb) return null;
  try {
    const felder = { ...msgFelder(cfb), gesendet: zeitAus(cfb) || "" };
    return form({
      quelle: "msg",
      kopfText: msgText(cfb, "007D"),
      felder,
      html: htmlAus(cfb),
      anhaenge: anhaengeAus(cfb).map((a) => ({ name: a.name, groesse: a.groesse, daten: a.daten })),
    });
  } catch {
    return null;
  }
}

export function pruefMailAusEml(bytes) {
  const g = emlLesen(bytes);
  if (!g) return null;
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const n = text.search(/\r?\n\r?\n/);
  return form({
    quelle: "eml",
    kopfText: n >= 0 ? text.slice(0, n) : text,
    felder: g,
    html: g.html,
    anhaenge: emlAnhaenge(bytes).map((a) => {
      const d = a.daten;
      let groesse = 0;
      try { groesse = d().length; } catch { /* bleibt 0 */ }
      return { name: a.name, groesse, daten: d };
    }),
  });
}

/* Eingefügter Text: nur Kopfzeilen. Ohne `From:` oder `Received:` ist es
   keine Kopfzeile einer Mail, sondern etwas anderes aus der
   Zwischenablage – dann lieber nichts als ein leerer Bericht. */
export function pruefMailAusKopf(text) {
  const kopf = kopfzeilenZerlegen(text);
  if (!kopf.some((z) => /^(from|received)$/i.test(z.name))) return null;
  return form({ quelle: "kopf", kopfText: text, felder: null, html: "", anhaenge: [] });
}

/* Nach Inhalt, nicht nur nach Endung: eine .msg beginnt mit der
   OLE2-Signatur, alles andere wird als Text versucht. */
export function pruefMailAusDatei(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!u8.length) return null;
  if (u8[0] === 0xD0 && u8[1] === 0xCF) return pruefMailAusMsg(u8);
  return pruefMailAusEml(u8) || pruefMailAusKopf(new TextDecoder("utf-8", { fatal: false }).decode(u8));
}
