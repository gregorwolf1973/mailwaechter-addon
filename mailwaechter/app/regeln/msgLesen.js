/* kopiert aus planungstool (src/domain/msgLesen.js), nicht hier ändern – scripts/regeln-holen.mjs */
import { htmlAusRtfStrom } from "./rtfLesen.js";

/* ============================================================
   Outlook-Mails (.msg) lesen – Betreff, Absender, Text, Anhänge

   In `I:\Auftraege` liegen 55.211 abgelegte Mails (Stand 06.08.2026,
   44,6 GB, zurück bis 1994). Sie sind das Gedächtnis der Projekte, aber
   bis hierher unerreichbar: der Explorer kann nur Dateinamen suchen, und
   die Namenskonvention `JJJJ-MM-TT@HH-MM_Betreff.msg` gibt es erst seit
   etwa 2019 – ältere Mails heißen einfach `AW_ Angebot ….msg`.

   Dieses Modul öffnet eine `.msg` und gibt heraus, was zum Suchen taugt.
   Es ist REINE FACHLOGIK: Eingabe ist ein `Uint8Array`, Ausgabe ein
   Objekt. Kein React, kein Dateisystem, kein Netz – deshalb im Test
   prüfbar und später auch auf dem Server verwendbar.

   DREI REGELN, die beim Ändern nicht fallen dürfen:

   1. NIE EINE AUSNAHME NACH AUSSEN. Eine beschädigte Mail unter
      tausend ist der Normalfall, kein Programmfehler. Was nicht lesbar
      ist, kommt als `null` zurück; der Aufrufer zählt und macht weiter.
      Eine einzige geworfene Ausnahme würde sonst die Suche über einen
      ganzen Auftrag abbrechen.

   2. JEDE SCHLEIFE HAT EINEN ZÄHLER. Die Sektorketten im Dateiformat
      sind verkettete Listen; eine beschädigte Datei kann einen Ring
      enthalten. Ohne Obergrenze hinge der Browser fest – und zwar
      unrettbar, weil das hier im Hauptfaden läuft.

   3. NICHTS WIRD GESCHRIEBEN. Dieses Modul liest. Die Auftragsordner
      echter, teils laufender Projekte werden nicht angefasst – das ist
      Regel 5 aus docs/ablage-struktur.md und gilt hier besonders,
      weil wir über 44 GB fremder Arbeit hinweglesen.

   ZUM FORMAT: `.msg` ist ein OLE2/Compound-File – ein Dateisystem in
   der Datei, mit Sektoren, Zuordnungstabelle (FAT) und Verzeichnis.
   Kleine Ströme liegen in einem eigenen Mini-Dateisystem mit 64-Byte-
   Sektoren. Die Mailfelder stehen darin als Ströme mit sprechenden
   Namen: `__substg1.0_0037001F` ist der Betreff in UTF-16.
   ============================================================ */

/* Formatkonstanten – auch von msgSparsam.js gebraucht. Zweimal
   geschrieben waeren sie zweimal zu pflegen, und das Bauwerkzeug des
   eigenstaendigen Werkzeugs meldet die Dopplung ohnehin als
   Namenskollision. */
export const SIGNATUR = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
export const FREI = 0xFFFFFFFF, ENDE = 0xFFFFFFFE, FAT_SEKTOR = 0xFFFFFFFD, DIFAT_SEKTOR = 0xFFFFFFFC;

/* Obergrenzen. Sie sind bewusst grosszuegig – die groesste echte Mail in
   der Ablage hat 51 MB – und trotzdem endlich. */
export const MAX_SEKTOREN = 1 << 22;
export const MAX_VERZEICHNIS = 1 << 16;

/* ------------------------------------------------------------------
   Das Compound-File oeffnen. Rueckgabe: { eintraege, strom } oder null.
   ------------------------------------------------------------------ */
export function cfbOeffnen(bytes) {
  try {
    if (!bytes || bytes.length < 512) return null;
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATUR[i]) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const sekGroesse = 1 << dv.getUint16(0x1E, true);
    const miniGroesse = 1 << dv.getUint16(0x20, true);
    if (sekGroesse !== 512 && sekGroesse !== 4096) return null;
    const fatAnzahl = dv.getUint32(0x2C, true);
    const dirStart = dv.getUint32(0x30, true);
    const miniGrenze = dv.getUint32(0x38, true);
    const miniFatStart = dv.getUint32(0x3C, true);
    const miniFatAnzahl = dv.getUint32(0x40, true);
    const difatStart = dv.getUint32(0x44, true);
    const difatAnzahl = dv.getUint32(0x48, true);
    const proSektor = sekGroesse / 4;
    const off = (sek) => (sek + 1) * sekGroesse;

    /* Die Liste der FAT-Sektoren steht zu 109 Stueck im Kopf, der Rest in
       eigenen DIFAT-Sektoren. OHNE DIESEN ZWEITEN TEIL bricht jede Datei
       ueber ~6,8 MB ab – in der Ablage sind das mehrere hundert. */
    const fatSektoren = [];
    for (let i = 0; i < 109 && fatSektoren.length < fatAnzahl; i++) {
      const s = dv.getUint32(0x4C + i * 4, true);
      if (s === FREI || s === ENDE) break;
      fatSektoren.push(s);
    }
    let ds = difatStart, runde = 0;
    while (ds !== ENDE && ds !== FREI && fatSektoren.length < fatAnzahl && runde++ <= difatAnzahl + 8) {
      if (off(ds) + sekGroesse > bytes.length) break;
      const basis = off(ds);
      for (let i = 0; i < proSektor - 1; i++) {
        const s = dv.getUint32(basis + i * 4, true);
        if (s === FREI || s === ENDE) break;
        fatSektoren.push(s);
      }
      ds = dv.getUint32(basis + sekGroesse - 4, true);
    }

    const fat = new Uint32Array(fatSektoren.length * proSektor);
    fatSektoren.forEach((s, n) => {
      const basis = off(s);
      if (basis + sekGroesse > bytes.length) return;
      for (let i = 0; i < proSektor; i++) fat[n * proSektor + i] = dv.getUint32(basis + i * 4, true);
    });

    /* Eine Sektorkette einsammeln. `max` ist die Reissleine aus Regel 2. */
    const kette = (start, max) => {
      const k = [];
      let s = start;
      while (s !== ENDE && s !== FREI && s !== FAT_SEKTOR && s !== DIFAT_SEKTOR && k.length < max) {
        if (s >= fat.length && k.length) break;
        k.push(s);
        const n = fat[s];
        if (n === undefined) break;
        s = n;
      }
      return k;
    };

    const ausSektoren = (start, laenge) => {
      const raus = new Uint8Array(Math.max(0, laenge));
      let p = 0;
      for (const s of kette(start, Math.ceil(laenge / sekGroesse) + 1)) {
        const n = Math.min(sekGroesse, laenge - p);
        if (n <= 0) break;
        const a = off(s);
        if (a + n > bytes.length) break;
        raus.set(bytes.subarray(a, a + n), p);
        p += n;
      }
      return raus;
    };

    /* Das Verzeichnis ist ein Rot-Schwarz-Baum.
       Fuer die Mailfelder reicht die flache Liste – ihre Namen sind
       eindeutig. Fuer ANHAENGE reicht sie NICHT: jeder Anhang ist eine
       eigene Ablage mit Kindern, die alle gleich heissen
       (`__substg1.0_3707001F` = Dateiname, `…_37010102` = Inhalt). Flach
       gelesen weiss man nicht, welcher Inhalt zu welchem Namen gehoert.
       Deshalb werden `kind`, `links` und `rechts` mitgefuehrt; wer sie
       nicht braucht, sieht sie nicht.

       `id` ist die Position im Verzeichnis – die Verweise zeigen darauf,
       nicht auf einen Namen. Deshalb duerfen hier auch die leeren
       Eintraege NICHT uebersprungen werden: sonst verschieben sich alle
       folgenden Nummern und der Baum zeigt ins Nichts. */
    const dirSektoren = kette(dirStart, MAX_VERZEICHNIS);
    const dirRoh = ausSektoren(dirStart, dirSektoren.length * sekGroesse);
    const ddv = new DataView(dirRoh.buffer, dirRoh.byteOffset, dirRoh.byteLength);
    const alleEintraege = [];
    for (let p = 0; p + 128 <= dirRoh.byteLength; p += 128) {
      const typ = ddv.getUint8(p + 0x42);
      const nameBytes = ddv.getUint16(p + 0x40, true);
      let name = "";
      for (let i = 0; i + 1 < nameBytes - 2 && i < 62; i += 2) name += String.fromCharCode(ddv.getUint16(p + i, true));
      alleEintraege.push({
        id: alleEintraege.length, name, typ,
        links: ddv.getUint32(p + 0x44, true),
        rechts: ddv.getUint32(p + 0x48, true),
        kind: ddv.getUint32(p + 0x4C, true),
        start: ddv.getUint32(p + 0x74, true),
        groesse: ddv.getUint32(p + 0x78, true),
      });
    }
    /* Nach aussen weiterhin nur, was ein Objekt ist – die leeren Plaetze
       sind Buchhaltung des Formats. */
    const eintraege = alleEintraege.filter((e) => e.typ === 1 || e.typ === 2 || e.typ === 5);
    const wurzel = eintraege.find((e) => e.typ === 5);
    if (!wurzel) return null;

    /* Die Kinder einer Ablage einsammeln. Der Baum wird durchlaufen,
       nicht sortiert – die Reihenfolge ist gleichgueltig, es geht um
       die Zugehoerigkeit. Der Zaehler ist die Reissleine aus Regel 2:
       ein beschaedigter Baum kann einen Ring enthalten. */
    const kinderVon = (eintrag) => {
      const raus = [];
      if (!eintrag || eintrag.kind === FREI) return raus;
      const offen = [eintrag.kind];
      const gesehen = new Set();
      let runden = 0;
      while (offen.length && runden++ < MAX_VERZEICHNIS) {
        const id = offen.pop();
        if (id === FREI || gesehen.has(id)) continue;
        gesehen.add(id);
        const e = alleEintraege[id];
        if (!e) continue;
        if (e.typ === 1 || e.typ === 2) raus.push(e);
        offen.push(e.links, e.rechts);
      }
      return raus;
    };

    /* Das Mini-Dateisystem fuer alles unter 4096 Bytes – und das sind
       fast alle Mailfelder ausser dem Text langer Mails. */
    const miniFat = new Uint32Array(Math.max(1, miniFatAnzahl) * proSektor);
    kette(miniFatStart, miniFatAnzahl + 8).forEach((s, n) => {
      const basis = off(s);
      if (basis + sekGroesse > bytes.length) return;
      for (let i = 0; i < proSektor; i++) miniFat[n * proSektor + i] = dv.getUint32(basis + i * 4, true);
    });
    const miniStrom = wurzel.groesse ? ausSektoren(wurzel.start, wurzel.groesse) : new Uint8Array(0);

    const strom = (e) => {
      if (!e || !e.groesse) return new Uint8Array(0);
      if (e.groesse >= miniGrenze) return ausSektoren(e.start, e.groesse);
      const raus = new Uint8Array(e.groesse);
      let s = e.start, p = 0, runden = 0;
      while (s !== ENDE && s !== FREI && p < e.groesse && runden++ < MAX_SEKTOREN) {
        const n = Math.min(miniGroesse, e.groesse - p);
        const a = s * miniGroesse;
        if (a + n > miniStrom.length) break;
        raus.set(miniStrom.subarray(a, a + n), p);
        p += n;
        const naechst = miniFat[s];
        if (naechst === undefined) break;
        s = naechst;
      }
      return raus;
    };

    return { eintraege, strom, kinderVon, wurzel };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
   Zeichenketten. Outlook legt Felder entweder als UTF-16 (Typ 001F) oder
   als Windows-1252 (Typ 001E) ab – Letzteres bei Mails aus den 2000ern.
   Beides kommt in der Ablage vor, also koennen wir beides.
   ------------------------------------------------------------------ */
const utf16 = (u8) => {
  let s = "";
  for (let i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode(u8[i] | (u8[i + 1] << 8));
  return s;
};
/* Nur der Bereich 128–159 weicht von Latin-1 ab; genau dort sitzen die
   Anfuehrungszeichen und Gedankenstriche, die Outlook gern verwendet. */
/* ALS CODEPUNKTE, nicht als Zeichenkette mit den Zeichen darin: die
   unbelegten Stellen (0x81, 0x8D, 0x8F, 0x90, 0x9D) sind in einer
   Zeichenkette nicht zu zaehlen. Beim ersten Anlauf stand dort ein
   Leerzeichen zu viel, alles ab 0x8E rutschte um eine Stelle, und aus
   einem Gedankenstrich wurde ein Aufzaehlungspunkt. Ein Fehler, den man
   im Code nicht sieht, sondern erst in einer Mail von 2007. */
const OBEN = {};
("20AC,,201A,0192,201E,2026,2020,2021,02C6,2030,0160,2039,0152,,017D,,"
  + ",2018,2019,201C,201D,2022,2013,2014,02DC,2122,0161,203A,0153,,017E,0178")
  .split(",").forEach((hex, i) => { if (hex) OBEN[0x80 + i] = String.fromCharCode(parseInt(hex, 16)); });
const cp1252 = (u8) => {
  let s = "";
  for (const b of u8) s += b >= 0x80 && b <= 0x9F ? (OBEN[b] || "") : String.fromCharCode(b);
  return s;
};

/* Outlook schliesst Zeichenketten mit einem Nullbyte ab; es gehoert
   nicht zum Inhalt. Abgeschnitten wird per split, NICHT per Regex:
   ein Steuerzeichen im Regex merkt oxlint zu Recht an, und als
   Escape geschrieben ist es beim naechsten Lesen ein Raetsel. */
/* Beide Ablageformen einer Zeichenkette, die genauere zuerst. */
/** @type {[string, (u8: Uint8Array) => string][]} */
const KODIERUNGEN = [["001F", utf16], ["001E", cp1252]];

const NULLBYTE = String.fromCharCode(0);
const WAGENRUECKLAUF = String.fromCharCode(13);
const sauber = (s) => String(s || "").split(NULLBYTE)[0].split(WAGENRUECKLAUF).join("").trim();

/* ------------------------------------------------------------------
   Das Sendedatum steht NICHT als eigener Strom, sondern als fester
   Eintrag im Eigenschaftenblock: 32 Byte Kopf, dann je 16 Byte
   (Kennung, Merkmale, Wert). Fuer Zeitwerte ist der Wert ein FILETIME –
   100-Nanosekunden-Schritte seit dem 1.1.1601.

   Warum der Aufwand statt einfach des Dateidatums: das Dateidatum ist
   der Tag, an dem jemand die Mail abgelegt hat, nicht der Tag, an dem
   sie geschrieben wurde. Bei nachtraeglich sortierten Ordnern liegen da
   Jahre dazwischen.
   ------------------------------------------------------------------ */
const FILETIME_ZU_MS = 11644473600000;
export function zeitAus(cfb, kennungen = [0x0039, 0x0E06, 0x3007]) {
  const e = cfb.eintraege.find((x) => x.name === "__properties_version1.0");
  if (!e) return null;
  const roh = cfb.strom(e);
  if (roh.length < 32 + 16) return null;
  const dv = new DataView(roh.buffer, roh.byteOffset, roh.byteLength);
  for (const gesucht of kennungen) {
    for (let p = 32; p + 16 <= roh.byteLength; p += 16) {
      const typ = dv.getUint16(p, true);
      const kennung = dv.getUint16(p + 2, true);
      if (kennung !== gesucht || typ !== 0x0040) continue;
      const lo = dv.getUint32(p + 8, true), hi = dv.getUint32(p + 12, true);
      if (!lo && !hi) continue;
      const ms = (hi * 4294967296 + lo) / 10000 - FILETIME_ZU_MS;
      if (ms > 0 && ms < 4102444800000) return new Date(ms).toISOString();
    }
  }
  return null;
}

/* ------------------------------------------------------------------
   Die Anhaenge – Name UND Inhalt.

   Jeder Anhang ist eine eigene Ablage `__attach_version1.0_#00000000`
   mit gleichnamigen Kindern:

       __substg1.0_3707001F   langer Dateiname („Layout_V03.pdf")
       __substg1.0_3704001F   kurzer Name (8.3, Notnagel)
       __substg1.0_37010102   der Inhalt
       __substg1.0_370E001F   MIME-Typ

   Deshalb der Baum in `cfbOeffnen`: flach gelesen liessen sich Name und
   Inhalt nicht paaren. Das war schon fuer die Suche halb egal, aber
   „Anhang oeffnen" braucht beides zusammen.

   Die Inhalte werden NICHT hier kopiert – `daten()` holt sie erst auf
   Verlangen. Eine Mail mit 20 MB Anhaengen liegt sonst allein durchs
   Auflisten ein zweites Mal im Speicher, und beim Einlesen eines
   Auftrags geschieht das 1.200 Mal hintereinander.
   ------------------------------------------------------------------ */
export function anhaengeAus(cfb) {
  const raus = [];
  if (!cfb || !cfb.kinderVon) return raus;
  for (const ablage of cfb.kinderVon(cfb.wurzel)) {
    if (ablage.typ !== 1 || !ablage.name.startsWith("__attach_version1.0")) continue;
    const kinder = cfb.kinderVon(ablage);
    const feld = (kennung) => {
      for (const [typ, dekodieren] of KODIERUNGEN) {
        const e = kinder.find((x) => x.name === `__substg1.0_${kennung}${typ}`);
        if (e) return sauber(dekodieren(cfb.strom(e)));
      }
      return "";
    };
    const inhalt = kinder.find((x) => x.name === "__substg1.0_37010102");
    const name = feld("3707") || feld("3704");
    if (!name && !inhalt) continue;
    raus.push({
      name: name || "(ohne Namen)",
      typ: feld("370E"),
      /* Die Kennung, mit der die HTML-Fassung ein eingebettetes Bild
         anspricht: `<img src="cid:image001.jpg@01D9...">`. Ohne sie
         bliebe im HTML-Text jedes Bild ein leerer Rahmen. Die spitzen
         Klammern gehoeren zur Schreibweise, nicht zum Wert. */
      cid: feld("3712").replace(/^<|>$/g, ""),
      groesse: inhalt ? inhalt.groesse : 0,
      /* Erst auf Verlangen lesen – siehe Kopf. */
      daten: () => (inhalt ? cfb.strom(inhalt) : new Uint8Array(0)),
    });
  }
  return raus;
}

/* ------------------------------------------------------------------
   Die Felder einer geoeffneten Mail.
   ------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   Die HTML-Fassung der Mail.

   Outlook legt sie als BINAERSTROM ab (`__substg1.0_10130102`), nicht
   als Zeichenkette – die Kodierung steht getrennt in
   PR_INTERNET_CPID (0x3FDE). Deshalb lassen sich die Bytes nicht
   einfach wie ein Textfeld lesen.

   Rueckgabe ist der ROHE HTML-Text. Er wird hier NICHT bereinigt: das
   ist Aufgabe von `domain/mailHtml.js`, und es soll genau eine Stelle
   geben, die entscheidet, was in die Anzeige darf.
   ------------------------------------------------------------------ */
const CODEPAGE = {
  65001: "utf-8", 1252: "windows-1252", 1250: "windows-1250", 1251: "windows-1251",
  1253: "windows-1253", 1254: "windows-1254", 1257: "windows-1257",
  28591: "iso-8859-1", 28592: "iso-8859-2", 28605: "iso-8859-15", 20127: "ascii",
};

export function codepageAus(cfb) {
  const e = cfb.eintraege.find((x) => x.name === "__properties_version1.0");
  if (!e) return 0;
  const roh = cfb.strom(e);
  if (roh.length < 48) return 0;
  const dv = new DataView(roh.buffer, roh.byteOffset, roh.byteLength);
  for (let p = 32; p + 16 <= roh.byteLength; p += 16) {
    /* 0x3FDE = PR_INTERNET_CPID, Typ 0003 = 32-Bit-Zahl */
    if (dv.getUint16(p + 2, true) === 0x3FDE && dv.getUint16(p, true) === 0x0003) {
      return dv.getUint32(p + 8, true);
    }
  }
  return 0;
}

/* Sieht das wie HTML aus?

   ANLASS (06.08.2026): Bei 173 von 174 Mails aus I:\Auftraege\21300
   EXISTIERT der Strom `__substg1.0_10130102`, enthält aber nur acht bis
   sechzehn Bytes Binärmüll – kein HTML. In der Vorschau stand dann
   `bu␀T␀ ◆S◆␀␀`, während dieselbe Mail im RTF-Strom sauberes
   `<html xmlns:v=…>` trägt.

   Dass ein Strom da ist, heißt also nicht, dass Inhalt darin steht.
   Geprüft wird deshalb der Inhalt, nicht seine Anwesenheit. */
const wirktWieHtml = (s) => s.length >= 20 && /<[a-zA-Z!]/.test(s);

export function htmlAus(cfb) {
  const e = cfb.eintraege.find((x) => x.name === "__substg1.0_10130102");
  if (e && e.groesse) {
    const bytes = cfb.strom(e);
    const cp = codepageAus(cfb);
    const label = CODEPAGE[cp] || "windows-1252";
    let text = "";
    try {
      /* `fatal: false` ist Absicht: eine Mail mit einem kaputten Byte
         soll lesbar bleiben, nicht ganz verschwinden. */
      text = new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
      try { text = new TextDecoder("windows-1252").decode(bytes); } catch { text = cp1252(bytes); }
    }
    if (wirktWieHtml(text)) return text;
    /* Sonst weiter zum RTF – der trägt es bei diesen Mails. */
  }

  /* KEIN HTML-STROM – aber deshalb noch lange keine Textmail.
     Outlook legt HTML-Mails oft NUR als komprimiertes RTF ab, mit dem
     HTML eingekapselt darin. Gemessen an 150 Mails aus
     I:\Auftraege\21300: 130 hatten einen HTML-Strom, die übrigen 20
     nur RTF – und in ALLEN zwanzig steckte HTML.

     Ohne diesen Rückfall meldete der Reiter „keine formatierte
     Fassung", während Outlook dieselbe Mail formatiert zeigte. */
  const rtfEintrag = cfb.eintraege.find((x) => x.name === "__substg1.0_10090102");
  if (!rtfEintrag || !rtfEintrag.groesse) return "";
  return htmlAusRtfStrom(cfb.strom(rtfEintrag));
}

export function msgFelder(cfb) {
  const holen = (kennung, wo = cfb.eintraege) => {
    for (const [typ, dekodieren] of KODIERUNGEN) {
      const e = wo.find((x) => x.name === `__substg1.0_${kennung}${typ}`);
      if (e) return sauber(dekodieren(cfb.strom(e)));
    }
    return "";
  };

  /* Bei Mails aus dem Haus steht in 0C1F der Exchange-Verzeichnisname
     (`/O=OLI-GMBH/OU=…`) statt einer Adresse. Als Erstes wird deshalb
     die SMTP-Adresse gesucht; was mit `/` beginnt, ist keine. */
  const adresse = [holen("5D01"), holen("5D02"), holen("0C1F")]
    .find((a) => a && a.includes("@") && !a.startsWith("/")) || "";

  const anhaenge = anhaengeAus(cfb).map((a) => a.name);

  return {
    betreff: holen("0037"),
    text: holen("1000"),
    /* PR_INTERNET_MESSAGE_ID. Sie ist der Anker, an dem eine abgelegte
       Datei und dieselbe Mail aus dem Postfach (Tabelle `mail`) als EINE
       erkannt werden – seit dem 12.08.2026 liegt manches doppelt vor.
       `emlLesen` liefert sie als `messageId`; beide Leser geben
       dieselben Felder heraus, und das gilt auch fuer dieses.
       Nicht jede `.msg` traegt sie: Entwuerfe und sehr alte Ablagen
       nicht. Dann bleibt sie leer, und die Mail zaehlt als eigene –
       doppelt zeigen ist besser als falsch zusammenlegen. */
    messageId: holen("1035"),
    vonName: holen("0C1A"),
    vonAdresse: adresse,
    an: holen("0E04"),
    cc: holen("0E03"),
    anhaenge,
    /* Liegt der Text nur als komprimiertes RTF vor, ist `text` leer.
       Das kommt vor; die Suche sagt es dann offen, statt so zu tun,
       als sei die Mail durchsucht. */
    nurRtf: !holen("1000") && cfb.eintraege.some((x) => x.name === "__substg1.0_10090102"),
  };
}

/* ------------------------------------------------------------------
   Der eine Aufruf, den die Oberflaeche braucht.
   `null` heisst: nicht lesbar – niemals eine Ausnahme (Regel 1).
   ------------------------------------------------------------------ */
export function msgLesen(bytes) {
  const cfb = cfbOeffnen(bytes);
  if (!cfb) return null;
  try {
    const f = msgFelder(cfb);
    return { ...f, gesendet: zeitAus(cfb) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
   Datum und Betreff aus dem DATEINAMEN – der zweite Weg zum Datum.

   Seit etwa 2019 heissen abgelegte Mails `2023-07-12@16-24_AW_ Betreff`
   (docs/ablage-struktur.md, „gelebte Konventionen"). Das kostet keinen
   Lesevorgang und traegt die Trefferliste, solange der Volltext noch
   nicht eingelesen ist.
   ------------------------------------------------------------------ */
export function ausDateiname(name) {
  const ohne = String(name || "").replace(/\.msg$/i, "");
  const m = ohne.match(/^(\d{4})-(\d{2})-(\d{2})@(\d{1,2})-(\d{2})_(.*)$/);
  if (!m) return { datum: "", betreff: ohne.replace(/_/g, " ").trim() };
  const [, j, mo, t, h, mi, rest] = m;
  return {
    datum: `${j}-${mo}-${t}`,
    zeit: `${String(h).padStart(2, "0")}:${mi}`,
    /* Outlook ersetzt beim Speichern `:` durch `_` – „AW_ Angebot" war
       einmal „AW: Angebot". Nur das erste, sonst zerlegt es Betreffs mit
       Unterstrichen. */
    betreff: rest.replace(/^(AW|WG|RE|FW|FWD)_/i, "$1:").trim(),
  };
}
