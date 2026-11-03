/* kopiert aus planungstool (src/domain/mailAnhangPruefung.js), nicht hier ändern – scripts/regeln-holen.mjs */
/* ============================================================
   Die Anhänge einer Mail beurteilen (19.10.2026)

   Geöffnet wird hier NICHTS – beurteilt werden Name und, bei
   ZIP-Archiven, das Inhaltsverzeichnis. Das reicht für die Fälle, die
   tatsächlich vorkommen:

   - Programme und Skripte (`.exe`, `.js`, `.lnk`, `.iso` …) – in
     Geschäftspost gibt es dafür keinen Grund.
   - Webseiten als Anhang (`.html`) – die nachgemachte Anmeldeseite, die
     ohne Link auskommt und deshalb an Linkfiltern vorbeigeht.
   - Office mit Makros (`.docm`, `.xlsm`) – kann echt sein, darf aber nie
     mit „Inhalt aktivieren" geöffnet werden.
   - Die doppelte Endung (`Rechnung.pdf.exe`) und das unsichtbare
     Umkehrzeichen U+202E, mit dem `Rechnung\u202efdp.exe` als
     „Rechnungexe.pdf" erscheint.
   - Das VERSCHLÜSSELTE ZIP mit dem Kennwort im Mailtext: kein
     Virenscanner kann hineinsehen, genau dafür wird es gemacht.

   `daten()` wird nur für ZIP-Dateien gerufen und nur bis 50 MB.
   ============================================================ */

const endung = (name) => (String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/) || [])[1] || "";

const PROGRAMM = new Set(("exe scr com pif bat cmd vbs vbe js jse wsf wsh ps1 psm1 hta lnk msi msp cpl jar "
  + "reg scf iso img vhd vhdx appx appxbundle msix one chm application gadget xll dll sys inf url library-ms "
  + "settingcontent-ms appref-ms").split(" "));
const WEBSEITE = new Set("html htm shtml xhtml mht mhtml".split(" "));
const MAKRO = new Set("docm dotm xlsm xltm xlsb xlam pptm potm ppam ppsm sldm".split(" "));
const ALT_OFFICE = new Set("doc xls ppt dot xlt pot rtf".split(" "));
const ARCHIV = new Set("zip rar 7z gz tgz tar ace arj cab bz2 xz z lzh r00 r01".split(" "));
const UMKEHR = /[\u202a-\u202e\u2066-\u2069]/;
const HARMLOS_VORNE = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|txt|csv|rtf)$/i;

/* ------------------------------------------------------------------
   Das Inhaltsverzeichnis eines ZIP: Name und „verschlüsselt" je
   Eintrag. Wie in xlsxLesen.js wird das zentrale Verzeichnis von
   hinten angelaufen – hier aber OHNE Ausnahme nach außen: ein kaputtes
   Archiv ist ein Befund, kein Programmfehler. Bit 0 der Merkmale
   (Versatz 8) heißt „verschlüsselt".
   ------------------------------------------------------------------ */
export function zipInhalt(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 22) return null;
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const anzahl = Math.min(v.getUint16(eocd + 10, true), 5000);
    let p = v.getUint32(eocd + 16, true);
    const eintraege = [];
    for (let n = 0; n < anzahl && p + 46 <= u8.length; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const merkmale = v.getUint16(p + 8, true);
      const nLen = v.getUint16(p + 28, true), eLen = v.getUint16(p + 30, true), kLen = v.getUint16(p + 32, true);
      const name = new TextDecoder(merkmale & 0x800 ? "utf-8" : "windows-1252").decode(u8.subarray(p + 46, p + 46 + nLen));
      eintraege.push({ name, verschluesselt: (merkmale & 1) === 1 });
      p += 46 + nLen + eLen + kLen;
    }
    return { eintraege };
  } catch {
    return null;
  }
}

/* Einen Dateinamen beurteilen – für Anhänge und für Einträge im Archiv. */
export function nameBeurteilen(name) {
  const n = String(name || "");
  const e = endung(n);
  if (UMKEHR.test(n)) {
    return { stufe: "rot", titel: "Dateiname mit verstecktem Umkehrzeichen", text: `„${n.replace(UMKEHR, "⟲")}“ – die Endung ist anders, als sie aussieht.` };
  }
  if (PROGRAMM.has(e)) {
    const doppelt = HARMLOS_VORNE.test(n.slice(0, -(e.length + 1)));
    return {
      stufe: "rot",
      titel: doppelt ? "Programm mit getarnter Endung" : "Programm oder Skript als Anhang",
      text: `„${n}“ ist eine .${e}-Datei${doppelt ? ", die sich als Dokument ausgibt" : ""} – nicht öffnen.`,
    };
  }
  if (WEBSEITE.has(e)) return { stufe: "rot", titel: "Webseite als Anhang", text: `„${n}“ – so kommen nachgemachte Anmeldeseiten an Linkfiltern vorbei. Nicht öffnen und nichts eingeben.` };
  if (e === "svg") return { stufe: "gelb", titel: "SVG-Bild als Anhang", text: `„${n}“ – ein SVG kann Skripte und Links enthalten. Nur öffnen, wenn erwartet.` };
  if (MAKRO.has(e)) return { stufe: "gelb", titel: "Office-Datei mit Makros", text: `„${n}“ – nur öffnen, wenn erwartet, und Makros („Inhalt aktivieren“) nie einschalten.` };
  if (ALT_OFFICE.has(e)) return { stufe: "info", titel: "Älteres Office-Format", text: `„${n}“ kann Makros enthalten – Makros nicht einschalten.` };
  return null;
}

/* ------------------------------------------------------------------
   Alle Anhänge. `anhaenge`: [{ name, groesse, daten? }]. Rückgabe:
   { befunde, liste } – `liste` trägt je Anhang seine Stufe für die
   Anzeige, bei Archiven auch die Namen darin.
   ------------------------------------------------------------------ */
export function anhaengePruefen(anhaenge, { kennwortImText = false } = {}) {
  const befunde = [];
  const liste = [];
  for (const a of anhaenge || []) {
    const eintrag = { name: a.name, groesse: a.groesse || 0, stufe: "", inhalt: null };
    const b = nameBeurteilen(a.name);
    if (b) { befunde.push(b); eintrag.stufe = b.stufe; }
    if (ARCHIV.has(endung(a.name))) {
      let zip = null;
      if (endung(a.name) === "zip" && typeof a.daten === "function" && (a.groesse || 0) <= 50 * 1024 * 1024) {
        try { zip = zipInhalt(a.daten()); } catch { zip = null; }
      }
      if (zip) {
        eintrag.inhalt = zip.eintraege.map((x) => x.name);
        if (zip.eintraege.some((x) => x.verschluesselt)) {
          befunde.push({
            stufe: "rot", titel: "Verschlüsseltes Archiv",
            text: `„${a.name}“ ist mit Kennwort geschützt – kein Virenscanner kann hineinsehen. ${kennwortImText ? "Das Kennwort steht in der Mail: genau so wird Schadsoftware verschickt." : "Nur öffnen, wenn der Absender das vorher angekündigt hat."}`,
          });
          eintrag.stufe = "rot";
        }
        for (const x of zip.eintraege) {
          const bx = nameBeurteilen(x.name.split("/").pop());
          if (bx && bx.stufe !== "info") {
            befunde.push({ ...bx, titel: bx.titel + " (im Archiv)", text: `In „${a.name}“: ${bx.text}` });
            if (bx.stufe === "rot" || !eintrag.stufe) eintrag.stufe = bx.stufe;
          }
        }
      } else {
        befunde.push({ stufe: "info", titel: "Archiv als Anhang", text: `„${a.name}“ – der Inhalt ließ sich hier nicht einsehen. Vor dem Öffnen prüfen, ob der Absender ein Archiv angekündigt hat.` });
        if (!eintrag.stufe) eintrag.stufe = "info";
      }
    }
    liste.push(eintrag);
  }
  return { befunde, liste };
}
