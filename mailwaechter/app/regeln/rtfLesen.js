/* kopiert aus planungstool (src/domain/rtfLesen.js), nicht hier ändern – scripts/regeln-holen.mjs */
/* ============================================================
   Den RTF-Strom einer Mail lesen – und das HTML darin auspacken

   ANLASS (06.08.2026): Der Reiter meldete „keine formatierte Fassung",
   obwohl Outlook dieselbe Mail formatiert anzeigt. Grund: Outlook legt
   HTML-Mails oft NICHT als `PR_HTML` ab, sondern als komprimiertes RTF
   mit dem HTML **eingekapselt** darin. Gemessen an 150 Mails aus
   `I:\Auftraege\21300`: 130 hatten einen HTML-Strom, die übrigen 20
   nur RTF – und in ALLEN ZWANZIG steckte HTML.

   Ohne diese Datei bliebe die formatierte Anzeige für einen von sieben
   Schriftwechseln unerreichbar, ohne dass jemand sagen könnte, warum.

   ZWEI SCHRITTE, beide hier:

   1. AUSPACKEN (`rtfEntpacken`) – LZFu nach MS-OXRTFCP. Ein
      Wörterbuchverfahren mit einem 4096 Byte großen Ring, der NICHT
      leer startet: er ist mit einem festen RTF-Vorspann vorbelegt.
      Steht darin auch nur ein Zeichen falsch, kommt Buchstabensalat
      heraus – deshalb steht er hier ausgeschrieben und wird nicht
      „aufgeräumt".

   2. AUSPACKEN DES HTML (`htmlAusRtf`) – nach MS-OXRTFEX. Das Markup
      steht in Gruppen `{\*\htmltag …}`, der sichtbare Text dazwischen;
      Bereiche zwischen `\htmlrtf` und `\htmlrtf0` gehören NUR zur
      RTF-Darstellung und müssen übersprungen werden.

   REIN UND TESTBAR: Bytes hinein, Text heraus. Kein DOM, kein React.
   Was hier herauskommt, ist ROHES HTML – bereinigt wird es in
   `domain/mailHtml.js`, der einen Stelle, die entscheidet, was in die
   Anzeige darf.
   ============================================================ */

/* Der vorbelegte Wörterbuchinhalt. Exakt so, Zeichen für Zeichen –
   inklusive der Leerzeichen hinter den Schriftarten und des `\r\n`. */
const WOERTERBUCH_START = "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}"
  + "{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArial"
  + "Times New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx";

const MAGIE_LZFU = 0x75465a4c;   /* "LZFu" – komprimiert   */
const MAGIE_MELA = 0x414c454d;   /* "MELA" – unkomprimiert */

/* ------------------------------------------------------------------
   Schritt 1: LZFu auspacken. Rückgabe ist der RTF-Text (ein Byte je
   Zeichen – die Kodierung wird erst in Schritt 2 aufgelöst).
   ------------------------------------------------------------------ */
export function rtfEntpacken(bytes) {
  try {
    if (!bytes || bytes.length < 16) return "";
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rohGroesse = dv.getUint32(4, true);
    const magie = dv.getUint32(8, true);

    if (magie === MAGIE_MELA) {
      let s = "";
      for (let i = 16; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    if (magie !== MAGIE_LZFU) return "";
    /* Eine unsinnige Größenangabe ist der billigste Schutz gegen eine
       beschädigte Datei, die uns Speicher kostet. */
    if (rohGroesse > 64 * 1024 * 1024) return "";

    const woerter = new Uint8Array(4096);
    for (let i = 0; i < WOERTERBUCH_START.length; i++) woerter[i] = WOERTERBUCH_START.charCodeAt(i);
    let schreib = WOERTERBUCH_START.length;
    let p = 16;
    const stuecke = [];
    let laenge = 0;
    let runden = 0;

    while (p < bytes.length && laenge < rohGroesse && runden++ < (1 << 24)) {
      const flags = bytes[p++];
      for (let bit = 0; bit < 8 && p < bytes.length && laenge < rohGroesse; bit++) {
        if (flags & (1 << bit)) {
          /* Verweis ins Wörterbuch: 12 Bit Stelle, 4 Bit Länge (+2). */
          if (p + 1 >= bytes.length) return stuecke.join("");
          const a = bytes[p++], b = bytes[p++];
          const stelle = (a << 4) | (b >> 4);
          const len = (b & 0x0F) + 2;
          /* Zeigt der Verweis auf die Schreibstelle selbst, ist der
             Strom zu Ende. Das ist die Endmarke des Formats – ohne sie
             liefe die Schleife in den Rest des Puffers. */
          if (stelle === schreib) return stuecke.join("");
          for (let i = 0; i < len; i++) {
            const z = woerter[(stelle + i) % 4096];
            stuecke.push(String.fromCharCode(z));
            laenge++;
            woerter[schreib] = z;
            schreib = (schreib + 1) % 4096;
          }
        } else {
          const z = bytes[p++];
          stuecke.push(String.fromCharCode(z));
          laenge++;
          woerter[schreib] = z;
          schreib = (schreib + 1) % 4096;
        }
      }
    }
    return stuecke.join("");
  } catch {
    return "";
  }
}

/* Steckt in diesem RTF eingekapseltes HTML? */
export const istEingekapseltesHtml = (rtf) => /\\fromhtml1?\b/.test(String(rtf || ""));

/* ------------------------------------------------------------------
   Schritt 2: das HTML herausholen.

   Der Kern ist eine kleine Zustandsmaschine über den RTF-Text:

     \htmlrtf … \htmlrtf0   NUR für die RTF-Darstellung → überspringen
     {\*\htmltag N …}       das ursprüngliche HTML-Markup → ausgeben
     {\*\… }                jede andere Sterngruppe → ganz überspringen
     \'41                   ein Byte in der Codepage des Dokuments
     \u8222?                ein Unicode-Zeichen, danach ein Ersatzzeichen
     \par \tab \line        Umbrüche
     Text                   der sichtbare Inhalt → ausgeben
   ------------------------------------------------------------------ */
const CP1252_OBEN = {};
("20AC,,201A,0192,201E,2026,2020,2021,02C6,2030,0160,2039,0152,,017D,,"
  + ",2018,2019,201C,201D,2022,2013,2014,02DC,2122,0161,203A,0153,,017E,0178")
  .split(",").forEach((hex, i) => { if (hex) CP1252_OBEN[0x80 + i] = String.fromCharCode(parseInt(hex, 16)); });

const byteZuZeichen = (b, cp) => {
  if (b < 0x80) return String.fromCharCode(b);
  if (cp === 1252 || !cp) return b <= 0x9F ? (CP1252_OBEN[b] || "") : String.fromCharCode(b);
  /* Für die übrigen Codepages ist Latin-1 die beste Näherung ohne
     Tabellen – betroffen sind einzelne Sonderzeichen, nicht der Text. */
  return String.fromCharCode(b);
};

/* Tabellen ohne Stern, deren Inhalt kein Text ist. Sie stehen am
   Anfang jedes RTF-Dokuments; ohne diese Liste beginnt die Anzeige mit
   den Namen der verwendeten Schriften. */
const TABELLEN = new Set([
  "fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
  "rsidtbl", "info", "filetbl", "revtbl", "generator", "pntext", "pntxta", "pntxtb",
]);

export function htmlAusRtf(rtf) {
  const text = String(rtf || "");
  if (!text) return "";

  const cpTreffer = text.match(/\\ansicpg(\d+)/);
  const cp = cpTreffer ? +cpTreffer[1] : 1252;

  const raus = [];
  /* `htmlrtf` zählt NICHT verschachtelt: `\htmlrtf0` schaltet immer
     ab, gleich wie oft vorher eingeschaltet wurde. */
  let ueberspringen = false;
  /* Tiefe der Gruppen, die ganz zu überspringen sind (`{\*\…}` außer
     htmltag), und die Tiefe, in der sie begann. */
  const stapel = [];
  let tiefe = 0;
  let sternGruppeAb = -1;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const z = text[i];

    if (z === "{") {
      tiefe++;
      stapel.push(ueberspringen);
      i++;
      /* Gruppen, deren Inhalt kein sichtbarer Text ist.

         ZWEI ARTEN, und die zweite ist leicht zu übersehen:
         `{\*\name …}` sind Steuergruppen – davon liefert nur `htmltag`
         HTML. Daneben gibt es Tabellen OHNE Stern: `{\fonttbl …}`,
         `{\colortbl …}`, `{\stylesheet …}`. Ohne sie zu überspringen
         stünden die Schriftnamen mitten im Text („Arial;Text"). */
      if (text.startsWith("\\*\\", i)) {
        const name = (text.slice(i + 3).match(/^[a-zA-Z]+/) || [""])[0];
        if (name !== "htmltag" && sternGruppeAb < 0) sternGruppeAb = tiefe;
      } else if (text[i] === "\\") {
        const name = (text.slice(i + 1).match(/^[a-zA-Z]+/) || [""])[0];
        if (TABELLEN.has(name) && sternGruppeAb < 0) sternGruppeAb = tiefe;
      }
      continue;
    }
    if (z === "}") {
      if (sternGruppeAb === tiefe) sternGruppeAb = -1;
      tiefe--;
      ueberspringen = stapel.pop() ?? false;
      i++;
      continue;
    }

    if (z === "\\") {
      /* Maskierte Sonderzeichen */
      const naechst = text[i + 1];
      if (naechst === "\\" || naechst === "{" || naechst === "}") {
        if (!ueberspringen && sternGruppeAb < 0) raus.push(naechst);
        i += 2;
        continue;
      }
      if (naechst === "'") {
        const hex = text.substr(i + 2, 2);
        if (!ueberspringen && sternGruppeAb < 0) raus.push(byteZuZeichen(parseInt(hex, 16) || 0, cp));
        i += 4;
        continue;
      }
      if (naechst === "\r" || naechst === "\n") { i += 2; continue; }

      /* Steuerwort mit optionaler Zahl */
      const m = text.slice(i + 1).match(/^([a-zA-Z]+)(-?\d+)?[ ]?/);
      if (!m) { i += 2; continue; }
      const wort = m[1];
      const zahl = m[2] === undefined ? null : +m[2];
      i += 1 + m[0].length;

      if (wort === "htmlrtf") { ueberspringen = zahl !== 0; continue; }
      if (ueberspringen || sternGruppeAb >= 0) continue;

      if (wort === "par" || wort === "line") { raus.push("\n"); continue; }
      if (wort === "tab") { raus.push("\t"); continue; }
      if (wort === "u" && zahl !== null) {
        raus.push(String.fromCharCode(zahl < 0 ? zahl + 65536 : zahl));
        /* Nach `\uN` folgt ein Ersatzzeichen für alte Leser – es gehört
           nicht in die Ausgabe. */
        if (text[i] === "?") i++;
        continue;
      }
      /* Alle übrigen Steuerwörter (Schriftgrößen, Farben, Ausrichtung)
         beschreiben die RTF-Darstellung und haben im HTML nichts zu
         suchen: dort steht das Markup schon in den htmltag-Gruppen. */
      continue;
    }

    if (z === "\r" || z === "\n") { i++; continue; }

    if (!ueberspringen && sternGruppeAb < 0) raus.push(z);
    i++;
  }

  return raus.join("");
}

/* Der eine Aufruf: komprimierter RTF-Strom hinein, rohes HTML heraus.
   Leer, wenn kein HTML eingekapselt ist – dann ist es echtes RTF, und
   das zu wandeln wäre ein eigenes Vorhaben (dort hilft „in Outlook
   öffnen" mehr als eine halbe Nachbildung). */
export function htmlAusRtfStrom(bytes) {
  const rtf = rtfEntpacken(bytes);
  if (!rtf || !istEingekapseltesHtml(rtf)) return "";
  return htmlAusRtf(rtf);
}
