/* kopiert aus planungstool (src/domain/anhangLinks.js), nicht hier ändern – scripts/regeln-holen.mjs */
/* ============================================================
   Links in den Anhängen – PDF und QR-Code (28.10.2026)

   Phishing kommt immer öfter OHNE Link in der Mail: eine PDF mit einem
   Knopf „Dokument ansehen“ oder ein QR-Code („Quishing“), den man mit
   dem Telefon abfotografiert – am Spamfilter und an jeder Linkprüfung
   vorbei. Was hier gefunden wird, prüft domain/mailPruefung.js wie
   jeden anderen Link.

   PDF: die Linkziele stehen als `/URI (…)` in den Anmerkungen, oft in
   komprimierten Objektströmen. Gelesen wird roh, ohne PDF-Bibliothek:
   jeder Strom mit /FlateDecode wird entpackt und mit durchsucht. JPEG-
   Bilder in der PDF (/DCTDecode) sind fertige Bilddateien – daraus
   liest die QR-Suche ebenfalls. Ein QR-Code, den die PDF als Vektoren
   zeichnet, bleibt unentdeckt; das bräuchte einen PDF-Renderer.

   QR: das Bild in Pixel zu verwandeln kann nur der Browser (Canvas),
   den Code zu lesen nur jsQR. Beides kommt von außen herein
   (`bildLesen`, `qrLesen`) – ohne sie gibt es nur die PDF-Links, und
   die Tests spielen beides vor.

   ASYNCHRON, weil Entpacken (DecompressionStream) und Bildlesen es
   sind. Die Oberfläche ruft es VOR der Prüfung auf und legt das
   Ergebnis als `mail.anhangLinks` ab.
   ============================================================ */

const BILD = /\.(png|jpe?g|gif|bmp|webp)$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
const GRENZE_DATEI = 15 * 1024 * 1024;
const GRENZE_ENTPACKT = 40 * 1024 * 1024;
const GRENZE_BILDER = 20;

/* Bytes als Zeichenkette, ein Zeichen je Byte – so stimmen die Stellen. */
function binText(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}

/* Entpacken; was bis zu einem Fehler kam, zählt (Ströme mit Müll am
   Ende sind häufig und enthalten trotzdem alles). */
async function entpacken(u8, grenze) {
  if (typeof DecompressionStream !== "function") return null;
  const ds = new DecompressionStream("deflate");
  const schreiber = ds.writable.getWriter();
  schreiber.write(u8).catch(() => {});
  schreiber.close().catch(() => {});
  const leser = ds.readable.getReader();
  const teile = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      teile.push(value);
      n += value.length;
      if (n > grenze) { leser.cancel().catch(() => {}); break; }
    }
  } catch { /* bis hierher gelesen */ }
  if (!n) return null;
  const raus = new Uint8Array(n);
  let o = 0;
  for (const t of teile) { raus.set(t.subarray(0, Math.min(t.length, n - o)), o); o += t.length; if (o >= n) break; }
  return raus;
}

/* Eine PDF-Zeichenkette `( … )` nach ISO 32000 7.3.4.2 */
function pdfLiteral(s) {
  const ESC = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  let raus = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") { raus += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (ESC[n] !== undefined) raus += ESC[n];
    else if (/[0-7]/.test(n)) {
      const okt = s.slice(i, i + 3).match(/^[0-7]{1,3}/)[0];
      raus += String.fromCharCode(parseInt(okt, 8) & 255);
      i += okt.length - 1;
    } else if (n === "\r") { if (s[i + 1] === "\n") i++; } else if (n !== "\n") raus += n;
  }
  return utf16Pruefen(raus);
}
const pdfHex = (s) => {
  const h = s.replace(/\s+/g, "");
  let raus = "";
  for (let i = 0; i < h.length; i += 2) raus += String.fromCharCode(parseInt((h[i] + (h[i + 1] || "0")), 16));
  return utf16Pruefen(raus);
};
/* Mit Byte-Order-Mark ist die Zeichenkette UTF-16BE */
function utf16Pruefen(s) {
  if (s.charCodeAt(0) !== 0xfe || s.charCodeAt(1) !== 0xff) return s;
  let raus = "";
  for (let i = 2; i + 1 < s.length; i += 2) raus += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  return raus;
}

/* `/URI (…)` und `/URI <…>` in einem Stück PDF. Klammern dürfen
   verschachtelt sein, solange sie paarig sind – daher von Hand. */
export function uriAusPdfText(s) {
  const raus = [];
  const muster = /\/URI\s*([(<])/g;
  for (let m; (m = muster.exec(s)) && raus.length < 500;) {
    let i = m.index + m[0].length;
    if (m[1] === "<") {
      const ende = s.indexOf(">", i);
      if (ende < 0) break;
      raus.push(pdfHex(s.slice(i, ende)));
      continue;
    }
    let tiefe = 1, roh = "";
    for (; i < s.length && i - m.index < 4000; i++) {
      const c = s[i];
      if (c === "\\") { roh += c + (s[i + 1] ?? ""); i++; continue; }
      if (c === "(") tiefe++;
      else if (c === ")" && !--tiefe) break;
      roh += c;
    }
    raus.push(pdfLiteral(roh));
  }
  return raus.map((x) => x.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------
   Eine PDF: { links, jpegs }. `links` ohne Doppelte, `jpegs` als
   Uint8Array (höchstens GRENZE_BILDER).
   ------------------------------------------------------------------ */
export async function pdfInhalt(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = binText(u8);
  const links = new Set(uriAusPdfText(text));
  const jpegs = [];
  let entpackt = 0;
  const strom = /\bstream\r?\n/g;
  for (let m, n = 0; (m = strom.exec(text)) && n < 2000; n++) {
    const anfang = m.index + m[0].length;
    const ende = text.indexOf("endstream", anfang);
    if (ende < 0) break;
    /* Das Wörterbuch davor: ab dem letzten „obj“ */
    const vorne = text.lastIndexOf("obj", m.index);
    const wb = vorne >= 0 && m.index - vorne < 4000 ? text.slice(vorne, m.index) : "";
    strom.lastIndex = ende;
    const filter = (wb.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [])[1] || "";
    const daten = u8.subarray(anfang, ende);
    if (/^\/FlateDecode$|^\[\s*\/FlateDecode\s*\]$/.test(filter) && entpackt < GRENZE_ENTPACKT) {
      const roh = await entpacken(daten, GRENZE_ENTPACKT - entpackt);
      if (!roh) continue;
      entpackt += roh.length;
      for (const l of uriAusPdfText(binText(roh))) links.add(l);
    } else if (/DCTDecode/.test(filter) && !/FlateDecode/.test(filter) && /\/Image\b/.test(wb) && jpegs.length < GRENZE_BILDER) {
      if (daten[0] === 0xff && daten[1] === 0xd8) jpegs.push(daten.slice());
    }
  }
  return { links: [...links], jpegs };
}

const istPdf = (name, u8) => /\.pdf$/i.test(name) || (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46);
const sieht = (s) => /^(https?:\/\/|www\.)/i.test(String(s || "").trim());

/* ------------------------------------------------------------------
   Alle Anhänge: [{ ziel, quelle: "pdf"|"qr", anhang }].

   `bildLesen(bytes, mime)` → { data, width, height } (RGBA) oder null,
   `qrLesen(data, width, height)` → Text oder null. Fehlt eins, wird
   kein QR-Code gesucht. Gemeldet werden nur QR-Codes mit einer
   Webadresse – WLAN-Zugänge und Visitenkarten sind kein Link.
   ------------------------------------------------------------------ */
export async function anhangLinksAus(anhaenge, { bildLesen = null, qrLesen = null } = {}) {
  const raus = [];
  const gesehen = new Set();
  const dazu = (ziel, quelle, anhang) => {
    const z = String(ziel || "").trim();
    const k = quelle + "\n" + z;
    if (!z || gesehen.has(k) || raus.length >= 200) return;
    gesehen.add(k);
    raus.push({ ziel: z, quelle, anhang });
  };
  let bilder = 0;
  const qr = async (bytes, mime, anhang) => {
    if (!bildLesen || !qrLesen || bilder >= GRENZE_BILDER) return;
    bilder++;
    try {
      const b = await bildLesen(bytes, mime);
      const t = b && qrLesen(b.data, b.width, b.height);
      if (t && sieht(t)) dazu(t, "qr", anhang);
    } catch { /* kein lesbares Bild */ }
  };
  for (const a of anhaenge || []) {
    if (a.groesse > GRENZE_DATEI) continue;
    let u8;
    try { u8 = a.daten(); } catch { continue; }
    if (!u8?.length || u8.length > GRENZE_DATEI) continue;
    if (istPdf(a.name, u8)) {
      let p;
      try { p = await pdfInhalt(u8); } catch { continue; }
      for (const l of p.links) if (!/^mailto:/i.test(l)) dazu(l, "pdf", a.name);
      for (const j of p.jpegs) await qr(j, "image/jpeg", a.name);
    } else if (BILD.test(a.name)) {
      await qr(u8, MIME[a.name.split(".").pop().toLowerCase()] || "", a.name);
    }
  }
  return raus;
}
