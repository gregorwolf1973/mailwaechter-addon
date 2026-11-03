/* Zeichnet icon.png (128x128) und logo.png (250x100): ein weißer Briefumschlag
   mit Haken auf blauem Grund. Ohne Bibliothek, nur zlib. Vorläufig - darf
   später durch ein richtiges Bild ersetzt werden.
       node scripts/icons-erzeugen.mjs */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ziel = join(dirname(fileURLToPath(import.meta.url)), "..", "mailwaechter");

function crc32(u8) {
  let crc = 0xffffffff;
  for (const b of u8) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(typ, daten) {
  const t = Buffer.from(typ), l = Buffer.alloc(4), c = Buffer.alloc(4);
  l.writeUInt32BE(daten.length); c.writeUInt32BE(crc32(Buffer.concat([t, daten])));
  return Buffer.concat([l, t, daten, c]);
}
function png(b, h, pixel) {
  const roh = Buffer.alloc((b * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    roh[y * (b * 4 + 1)] = 0;
    for (let x = 0; x < b; x++) { const p = pixel(x, y); roh.set(p, y * (b * 4 + 1) + 1 + x * 4); }
  }
  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(b, 0); kopf.writeUInt32BE(h, 4); kopf[8] = 8; kopf[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", kopf), chunk("IDAT", deflateSync(roh)), chunk("IEND", Buffer.alloc(0))]);
}

const BLAU = [31, 95, 191, 255], WEISS = [255, 255, 255, 255], GRUEN = [67, 160, 71, 255], KEIN = [0, 0, 0, 0];

/* Abstand eines Punktes zur Strecke - für die Linien des Umschlags */
const dist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

function umschlag(cx, cy, w, h, x, y) {
  const l = cx - w / 2, o = cy - h / 2;
  if (x < l || x > l + w || y < o || y > o + h) return null;
  const rand = Math.min(x - l, l + w - x, y - o, o + h - y) < 2.5;
  const klappe = Math.min(dist(x, y, l, o, cx, cy + h * 0.05), dist(x, y, l + w, o, cx, cy + h * 0.05)) < 2.2;
  return rand || klappe ? BLAU : WEISS;
}
function haken(x, y, mx, my, s) {
  const d = Math.min(dist(x, y, mx - s * 0.6, my, mx - s * 0.15, my + s * 0.5), dist(x, y, mx - s * 0.15, my + s * 0.5, mx + s * 0.7, my - s * 0.5));
  return d < s * 0.16;
}
function bildpunkt(b, h, rund) {
  return (x, y) => {
    const ecke = rund ? 18 : 0;
    const dx = Math.max(ecke - x, 0, x - (b - 1 - ecke)), dy = Math.max(ecke - y, 0, y - (h - 1 - ecke));
    if (Math.hypot(dx, dy) > ecke) return KEIN;
    const u = umschlag(b / 2, h / 2 - 4, h * 0.62 * 1.4, h * 0.62, x, y);
    if (haken(x, y, b / 2 + h * 0.3, h / 2 + h * 0.2, h * 0.3)) return GRUEN;
    return u || BLAU;
  };
}
writeFileSync(join(ziel, "icon.png"), png(128, 128, bildpunkt(128, 128, true)));
writeFileSync(join(ziel, "logo.png"), png(250, 100, bildpunkt(250, 100, true)));
console.log("icon.png und logo.png geschrieben");
