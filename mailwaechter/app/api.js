import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

/* Die kleine Oberfläche hinter Home-Assistant-Ingress. Ingress reicht
   Anfragen ohne Pfadpräfix durch, die Seite nutzt deshalb nur relative
   Adressen ("api/status"). Nach draußen ist kein Port offen. */

const STATIK = join(fileURLToPath(new URL(".", import.meta.url)), "static");
const TYPEN = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

const json = (res, code, wert) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(wert));
};

async function koerper(req) {
  const teile = [];
  let n = 0;
  for await (const t of req) { n += t.length; if (n > 64_000) throw new Error("zu groß"); teile.push(t); }
  try { return JSON.parse(Buffer.concat(teile).toString("utf8") || "{}"); } catch { return {}; }
}

export function handlerBauen({ optionen, waechter, protokoll, bekannte, version = "0.1.0" }) {
  const test = { laeuft: false, ergebnis: null, fehler: "" };
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://x");
      const pfad = url.pathname.replace(/\/{2,}/g, "/");
      if (req.method === "GET" && pfad === "/api/status") {
        const s = waechter?.status || {};
        return json(res, 200, {
          version,
          konfiguriert: !!(optionen.gmailAdresse && optionen.appPasswort),
          gmail: optionen.gmailAdresse,
          nurMelden: optionen.nurMelden,
          verbunden: !!s.verbunden, seit: s.seit || null, fehler: s.fehler || "", naechsterVersuch: s.naechsterVersuch || null,
          letztePruefung: s.letztePruefung || null, geprueft: s.geprueft || 0,
          bekannteDomains: Object.keys(bekannte.domains).length, gesendetStand: bekannte.stand,
          test: { ...test },
        });
      }
      if (req.method === "GET" && pfad === "/api/eintraege") {
        const filter = url.searchParams.get("filter") || "alle";
        return json(res, 200, { eintraege: protokoll.liste(filter) });
      }
      if (req.method === "POST" && pfad === "/api/zurueckholen") {
        const { id } = await koerper(req);
        if (!waechter) return json(res, 503, { fehler: "Wächter läuft nicht (Zugangsdaten fehlen)" });
        try { return json(res, 200, { ok: true, ...(await waechter.zurueckholen(String(id || ""))) }); }
        catch (e) { return json(res, 500, { fehler: String(e?.message || e) }); }
      }
      if (req.method === "POST" && pfad === "/api/testlauf") {
        if (!waechter) return json(res, 503, { fehler: "Wächter läuft nicht (Zugangsdaten fehlen)" });
        if (test.laeuft) return json(res, 409, { fehler: "Ein Testlauf läuft schon" });
        test.laeuft = true; test.fehler = ""; test.ergebnis = null;
        waechter.testlauf(50).then((n) => { test.ergebnis = n; }).catch((e) => { test.fehler = String(e?.message || e); }).finally(() => { test.laeuft = false; });
        return json(res, 202, { ok: true });
      }
      if (req.method === "GET") {
        const rel = normalize(pfad === "/" ? "/index.html" : pfad).replace(/^[/\\]+/, "");
        const voll = join(STATIK, rel);
        if (!voll.startsWith(STATIK + sep) || !TYPEN[extname(voll)]) { res.writeHead(404); return res.end("nicht gefunden"); }
        try {
          const inhalt = await readFile(voll);
          res.writeHead(200, { "Content-Type": TYPEN[extname(voll)], "Cache-Control": "no-store" });
          return res.end(inhalt);
        } catch { res.writeHead(404); return res.end("nicht gefunden"); }
      }
      res.writeHead(405); res.end();
    } catch (e) {
      json(res, 500, { fehler: String(e?.message || e) });
    }
  };
}
