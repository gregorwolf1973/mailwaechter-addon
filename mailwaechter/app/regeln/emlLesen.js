/* kopiert aus planungstool (src/domain/emlLesen.js), nicht hier ändern – scripts/regeln-holen.mjs */
/* ============================================================
   `.eml` lesen – dieselbe Ausgabe wie `msgLesen`

   ANLASS (12.08.2026): Der Mail-Import legt die Mails im Auftragsordner
   ab. Was aus dem Postfach kommt, ist RFC 5322 (`.eml`) – `.msg` ist
   Outlooks eigenes Format und liesse sich ohne Outlook nicht schreiben.
   Der Reiter „Mails" las bis dahin AUSSCHLIESSLICH `.msg`. Ohne dieses
   Modul laege die abgelegte Mail im Ordner und das Werkzeug uebersaehe
   sie – zwei Klassen von Dateien am selben Ort, von denen es nur eine
   kennt.

   DIE AUSGABE IST DIESELBE wie bei `msgFelder`: betreff, text, vonName,
   vonAdresse, an, cc, anhaenge, gesendet. Nur so bleibt alles dahinter
   – Liste, Suche, Vorschau – bei EINER Form. Ein zweites Feldschema
   waere ein zweiter Satz Sonderfaelle in jeder Ansicht.

   BEWUSST OHNE BIBLIOTHEK und ohne Anspruch auf Vollstaendigkeit. Was
   gebraucht wird, sind Kopfzeilen, der Klartextrumpf und die Namen der
   Anhaenge. MIME kann mehr, als hier gelesen wird; was nicht erkannt
   wird, faellt auf „Rumpf wie er ist" zurueck, und das ist immer noch
   durchsuchbarer Text.

   `null` heisst: nicht lesbar – niemals eine Ausnahme. Dieselbe Regel
   wie in msgLesen.js.
   ============================================================ */

/* Eine Kopfzeile samt Fortsetzungszeilen (RFC 5322: eine Zeile, die mit
   Leerzeichen oder Tabulator beginnt, gehoert zur vorigen). */
export function kopfWert(kopf, name) {
  const m = String(kopf || "").match(new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "im"));
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

/* `=?UTF-8?B?…?=` und `=?ISO-8859-1?Q?…?=` aufloesen. Ohne das steht im
   Betreff „=?UTF-8?B?QXVmdHJhZ3M=?=" statt „Auftrags…". */
export function kopfDekodieren(roh) {
  /* ZUERST DIE LUECKE ZWISCHEN ZWEI KODIERTEN WORTSTUECKEN ENTFERNEN.
     RFC 2047 zerlegt lange Kopfzeilen in mehrere `=?…?=`-Stuecke; der
     Zwischenraum gehoert NICHT zum Text und muss weg, BEVOR dekodiert
     wird. Danach ist er nicht mehr von einem echten Leerzeichen zu
     unterscheiden.

     Der Befund, der das ans Licht brachte (12.08.2026): im Betreff
     einer abgelegten Mail stand `[PT-76 HHS]` statt `[PT-76HHS]` – die
     Kennung genau an der Stelle zerrissen, an der Outlook die Zeile
     umgebrochen hatte. Ueber das Postfach fiel es nicht auf, weil der
     IMAP-Umschlag schon dekodiert ankommt; erst beim Lesen der Datei
     zeigte es sich. Eine zerrissene Kennung findet ihr Projekt nie
     wieder. */
  return String(roh || "")
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, satz, art, inhalt) => {
    try {
      let bytes;
      if (art.toUpperCase() === "B") {
        const bin = atob(inhalt);
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } else {
        /* Quoted-Printable im Kopf: `_` ist ein Leerzeichen. */
        const s = inhalt.replace(/_/g, " ");
        const teile = [];
        for (let i = 0; i < s.length; i++) {
          if (s[i] === "=" && /[0-9A-F]{2}/i.test(s.slice(i + 1, i + 3))) { teile.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
          else teile.push(s.charCodeAt(i));
        }
        bytes = Uint8Array.from(teile);
      }
      const kodierung = /utf-?8/i.test(satz) ? "utf-8" : "iso-8859-1";
      return new TextDecoder(kodierung).decode(bytes);
    } catch { return inhalt; }
  });
}

/* Einen Teil dekodieren – base64 oder quoted-printable, sonst wie er ist. */
function rumpfDekodieren(rumpf, kodierung, zeichensatz) {
  const k = String(kodierung || "").toLowerCase();
  try {
    if (k.includes("base64")) {
      const bin = atob(String(rumpf).replace(/\s+/g, ""));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder(/utf-?8/i.test(zeichensatz || "") ? "utf-8" : "iso-8859-1").decode(bytes);
    }
    if (k.includes("quoted-printable")) {
      /* ERST BYTES, DANN DEKODIEREN. `=C3=BC` sind ZWEI Bytes, die
         zusammen ein „ü" ergeben – jedes einzeln in ein Zeichen zu
         verwandeln macht daraus „Ã¼". Genau so stand es hier im ersten
         Anlauf, und der Test hat es gefangen. */
      const s = String(rumpf).replace(/=\r?\n/g, "");
      const bytes = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "=" && /[0-9A-F]{2}/i.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
        else bytes.push(s.charCodeAt(i) & 0xFF);
      }
      return new TextDecoder(/utf-?8/i.test(zeichensatz || "") ? "utf-8" : "iso-8859-1")
        .decode(Uint8Array.from(bytes));
    }
  } catch { /* faellt auf den Rohtext zurueck */ }
  return String(rumpf);
}

/* Eine Nachricht in ihre MIME-Teile zerlegen. Rekursiv, weil
   `multipart/mixed` regelmaessig ein `multipart/alternative` enthaelt –
   der Text steckt dann eine Ebene tiefer. */
function teileAus(text) {
  const trenn = text.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const schnitt = text.indexOf(trenn);
  const kopf = schnitt >= 0 ? text.slice(0, schnitt) : text;
  const rumpf = schnitt >= 0 ? text.slice(schnitt + trenn.length) : "";
  const typ = kopfWert(kopf, "Content-Type");
  const grenze = (typ.match(/boundary="?([^"\r\n;]+)"?/i) || [])[1];
  if (!/multipart/i.test(typ) || !grenze) return [{ kopf, rumpf }];
  const stuecke = rumpf.split(new RegExp(`--${grenze.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(--)?\\r?\\n?`));
  const raus = [];
  for (const s of stuecke) {
    if (!s || !s.trim() || s === "--") continue;
    for (const t of teileAus(s)) raus.push(t);
  }
  return raus;
}

/* Der Dateiname eines Anhangs – aus `Content-Disposition` oder,
   ersatzweise, aus dem `name=` im Content-Type. */
function anhangName(kopf) {
  const cd = kopfWert(kopf, "Content-Disposition");
  const ct = kopfWert(kopf, "Content-Type");
  const m = (cd + "; " + ct).match(/(?:file)?name\*?="?([^";\r\n]+)"?/i);
  return m ? kopfDekodieren(m[1]).trim() : "";
}

/* ------------------------------------------------------------------
   Der eine Aufruf. `bytes` ist ein Uint8Array/ArrayBuffer oder Text.
   ------------------------------------------------------------------ */
export function emlLesen(bytes) {
  try {
    const text = typeof bytes === "string"
      ? bytes
      : new TextDecoder("utf-8", { fatal: false }).decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    if (!/^[\w-]+:/m.test(text)) return null; /* keine Kopfzeilen – keine Mail */

    const teile = teileAus(text);
    const hauptKopf = teile[0]?.kopf || "";
    /* Die Kopfzeilen der NACHRICHT stehen im ersten Teil nur, wenn sie
       nicht multipart ist. Sonst stehen sie ganz vorn im Rohtext. */
    const trenn = text.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
    const kopf = text.slice(0, Math.max(0, text.indexOf(trenn)));

    let klartext = "", html = "";
    const anhaenge = [];
    for (const t of teile) {
      const typ = kopfWert(t.kopf, "Content-Type");
      const name = anhangName(t.kopf);
      const anhang = /attachment/i.test(kopfWert(t.kopf, "Content-Disposition")) || (name && !/text\/(plain|html)/i.test(typ));
      if (anhang) { if (name) anhaenge.push(name); continue; }
      const satz = (typ.match(/charset="?([^";\r\n]+)"?/i) || [])[1];
      const inhalt = rumpfDekodieren(t.rumpf, kopfWert(t.kopf, "Content-Transfer-Encoding"), satz);
      if (/text\/html/i.test(typ)) html = html || inhalt;
      else if (!klartext) klartext = inhalt;
    }
    /* Nur HTML und kein Klartext: die Auszeichnung grob entfernen – die
       Suche braucht Woerter, keine Formatierung. */
    if (!klartext && html) {
      klartext = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }

    const von = kopfDekodieren(kopfWert(kopf, "From"));
    const adr = (von.match(/<([^>]+)>/) || [])[1] || (von.includes("@") ? von : "");
    const datum = kopfWert(kopf, "Date");
    const d = datum ? new Date(datum) : null;

    return {
      betreff: kopfDekodieren(kopfWert(kopf, "Subject")),
      text: klartext,
      html,
      vonName: von.replace(/<[^>]*>/, "").replace(/^"|"$/g, "").trim(),
      vonAdresse: adr.trim(),
      an: kopfDekodieren(kopfWert(kopf, "To")),
      cc: kopfDekodieren(kopfWert(kopf, "Cc")),
      anhaenge,
      nurRtf: false,
      gesendet: d && !isNaN(+d) ? d.toISOString() : "",
      messageId: kopfWert(kopf, "Message-ID"),
      hauptKopf,
    };
  } catch { return null; }
}

/* ------------------------------------------------------------------
   Die Anhaenge einer `.eml` mit INHALT.

   Dieselbe Form wie `anhaengeAus()` fuer `.msg` – `{ name, typ, cid,
   daten() }` –, damit `mailHtmlAufbereiten()` beide gleich behandelt.
   Die Aufbereitung ist die eine Stelle, die entscheidet, was aus einer
   fremden Mail in die Anzeige darf; sie ein zweites Mal zu schreiben
   waere der sichere Weg, sie an einer der beiden Stellen zu schwaechen.

   `daten()` ist eine Funktion und kein Feld: ein eingebettetes Foto
   kostet Speicher, und die meisten Anhaenge sieht nie jemand an.
   ------------------------------------------------------------------ */
export function emlAnhaenge(bytes) {
  try {
    const text = typeof bytes === "string"
      ? bytes
      : new TextDecoder("utf-8", { fatal: false }).decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const raus = [];
    for (const t of teileAus(text)) {
      const name = anhangName(t.kopf);
      const typ = (kopfWert(t.kopf, "Content-Type").split(";")[0] || "").trim();
      const inline = /inline/i.test(kopfWert(t.kopf, "Content-Disposition"));
      const anhang = /attachment/i.test(kopfWert(t.kopf, "Content-Disposition"))
        || inline || (name && !/text\/(plain|html)/i.test(typ));
      if (!anhang || (!name && !inline)) continue;
      const cid = (kopfWert(t.kopf, "Content-ID") || "").replace(/[<>]/g, "");
      const kodierung = kopfWert(t.kopf, "Content-Transfer-Encoding");
      const rumpf = t.rumpf;
      raus.push({
        name: name || cid || "(ohne Namen)",
        typ,
        cid,
        daten: () => {
          try {
            if (/base64/i.test(kodierung)) {
              const bin = atob(String(rumpf).replace(/\s+/g, ""));
              return Uint8Array.from(bin, (c) => c.charCodeAt(0));
            }
            return new TextEncoder().encode(String(rumpf));
          } catch { return new Uint8Array(0); }
        },
      });
    }
    return raus;
  } catch { return []; }
}
