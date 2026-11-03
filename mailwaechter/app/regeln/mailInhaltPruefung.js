/* kopiert aus planungstool (src/domain/mailInhaltPruefung.js), nicht hier ändern – scripts/regeln-holen.mjs */
/* ============================================================
   Der Text einer Mail – die Maschen, die sich an Wörtern zeigen
   (19.10.2026)

   Keine KI, keine Bewertung von Stil: eine kurze Liste von Mustern für
   die Betrugsarten, die eine Firma tatsächlich treffen. Jeder Treffer
   ist für sich nur ein HINWEIS – „dringend" steht in jeder zweiten
   echten Mail. Erst zusammen mit einem Befund zum Absender wird daraus
   ein Urteil; das entscheidet `mailPruefen` (domain/mailPruefung.js).

   Die Muster sind deutsch und englisch, weil die Kundschaft es ist.
   ============================================================ */

export const INHALT_REGELN = [
  {
    schluessel: "bank", stufe: "gelb", titel: "Geänderte Bankverbindung",
    text: "Die Mail spricht von neuen oder geänderten Bankdaten. Das ist die häufigste Betrugsmasche gegen Firmen: Bankverbindung nie auf eine Mail hin ändern, sondern unter einer BEKANNTEN Telefonnummer nachfragen.",
    muster: /(neue|geänderte|geaenderte|aktualisierte|andere)[nrs]?\s+(bank\s*verbindung|bankdaten|kontodaten|kontoverbindung|konto|iban)|(bank\s*verbindung|bankdaten|kontodaten|iban)\s+(hat|haben)\s+sich\s+geändert|änderung\s+(der|unserer|ihrer)\s+(bank|konto)|new\s+bank(ing)?\s+(details|account|information)|(changed|updated)\s+(our\s+)?bank(ing)?\s+(details|account|information)|bank(ing)?\s+(details|account)\s+(have|has)\s+(been\s+)?changed/i,
  },
  {
    schluessel: "zugang", stufe: "gelb", titel: "Aufforderung zur Anmeldung",
    text: "Es geht um Kennwort, Konto oder Postfach. Echte Dienste fragen nicht per Mail nach Zugangsdaten – nie über einen Link aus der Mail anmelden.",
    muster: /(passwort|kennwort|password|anmeldedaten|zugangsdaten)\b.{0,60}(bestätig|eingeb|aktualisier|abläuft|ablaeuft|erneuer|verify|confirm|update|expir)|(ihr|dein|your)\s+(konto|account|postfach|mailbox)\b.{0,40}(gesperrt|eingeschränkt|deaktiviert|suspend|locked|disabled|voll|full)|verify\s+your\s+(account|identity|e-?mail)|bestätigen\s+sie\s+ihre\s+(identität|e-?mail|konto)/i,
  },
  {
    schluessel: "gutschein", stufe: "gelb", titel: "Gutscheinkarten",
    text: "Bitten um Gutschein- oder Geschenkkarten sind ein typischer Chef-Betrug – kein echter Vorgesetzter will so bezahlt werden.",
    muster: /gutschein(karte|codes?)|geschenkkarte|gift\s*cards?|(itunes|google\s*play|amazon|steam|apple)[\s-]*(karte|card|gutschein)/i,
  },
  {
    schluessel: "chef", stufe: "gelb", titel: "„Bist du gerade erreichbar?“",
    text: "Kurze Fragen nach Erreichbarkeit oder einer „kleinen Aufgabe“ sind der übliche Einstieg in den Chef-Betrug.",
    muster: /(bist du|sind sie)\s+(gerade\s+|kurz\s+)?(am platz|erreichbar|im büro|verfügbar)\b|kurze\s+(aufgabe|bitte)\s+für\s+(dich|sie)|are\s+you\s+(available|at\s+your\s+desk)|quick\s+(favou?r|task)/i,
  },
  {
    schluessel: "druck", stufe: "info", titel: "Zeitdruck",
    text: "Die Mail drängt zur Eile. Druck soll das Nachdenken verhindern.",
    muster: /\b(dringend|umgehend|unverzüglich|innerhalb\s+von\s+(24|48)\s+stunden|heute\s+noch|letzte\s+mahnung|urgent|immediately|within\s+(24|48)\s+hours)\b/i,
  },
  {
    schluessel: "geheim", stufe: "info", titel: "Geheimhaltung",
    text: "„Vertraulich – mit niemandem besprechen“ ist beim Chef-Betrug Standard: es soll niemand nachfragen.",
    muster: /niemandem\s+(davon\s+)?(erzählen|sagen|weitergeben)|nicht\s+mit\s+(anderen|kollegen)\s+besprechen|keep\s+this\s+(between\s+us|confidential)/i,
  },
  {
    schluessel: "kennwort", stufe: "info", titel: "Kennwort in der Mail",
    text: "In der Mail steht ein Kennwort. Gehört es zu einem verschlüsselten Anhang, ist das ein Warnzeichen.",
    muster: /\b(passwort|kennwort|password|pw)\s*[:=]\s*\S+/i,
  },
];

/* Nur der Teil, den der Absender SELBST geschrieben hat – ohne die
   zitierte frühere Mail darunter. Für die IBAN-Prüfung: antwortet ein
   griechischer Kunde auf unsere Rechnung, steht UNSERE deutsche IBAN im
   Zitat, und die wäre sonst „eine IBAN aus einem anderen Land".
   Erkannt werden die Zitatköpfe von Outlook (deutsch/englisch) und die
   üblichen „Am … schrieb"-Zeilen. */
export function eigenerTeil(text) {
  const s = String(text || "");
  const m = s.match(/^\s*(?:-{2,}\s*(?:Original Message|Ursprüngliche Nachricht)|_{10,}|(?:Von|From):\s.+\n\s*(?:Gesendet|Sent|Datum|Date):|Am .{5,80} schrieb .{1,80}:|On .{5,80} wrote:)/im);
  return m ? s.slice(0, m.index) : s;
}

/* Betreff und Text gemeinsam – „Neue Bankverbindung" steht oft nur im
   Betreff. Ein Treffer je Regel genügt; die Fundstelle wird mitgegeben,
   damit der Bericht zeigen kann, WORAN es lag. */
export function inhaltPruefen(text, betreff = "") {
  const ganz = `${betreff}\n${text}`.slice(0, 200000);
  const raus = [];
  for (const r of INHALT_REGELN) {
    const m = ganz.match(r.muster);
    if (m) raus.push({ schluessel: r.schluessel, stufe: r.stufe, titel: r.titel, text: r.text, fundstelle: m[0].replace(/\s+/g, " ").slice(0, 80) });
  }
  return raus;
}
