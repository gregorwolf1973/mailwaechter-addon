/* Ein Protokoll auf der Konsole. Das App-Passwort wird nie ausgegeben:
   `geheimnis()` merkt es, `schwaerzen` ersetzt es in jeder Zeile. */
const STUFEN = { debug: 0, info: 1, warning: 2, error: 3 };
let stufe = 1;
let geheim = [];

export const logStufe = (name) => { stufe = STUFEN[name] ?? 1; };
export const geheimnis = (...werte) => { geheim = werte.filter((w) => w && String(w).length >= 4).map(String); };
export function schwaerzen(text) {
  let s = String(text);
  for (const g of geheim) s = s.split(g).join("***");
  return s;
}

function schreiben(name, ...teile) {
  if (STUFEN[name] < stufe) return;
  const zeile = teile.map((t) => (t instanceof Error ? t.message : typeof t === "string" ? t : JSON.stringify(t))).join(" ");
  (name === "error" ? console.error : console.log)(`${new Date().toISOString()} [${name}] ${schwaerzen(zeile)}`);
}
export const log = Object.fromEntries(Object.keys(STUFEN).map((n) => [n, (...t) => schreiben(n, ...t)]));
