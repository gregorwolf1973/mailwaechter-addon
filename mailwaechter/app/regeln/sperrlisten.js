/* kopiert aus planungstool (server/sperrlisten.js), nicht hier ändern – scripts/regeln-holen.mjs, mit kleinen Ersetzungen für Gmail */
import { imNetz } from "./spf.js";
import { dqsName, dqsFehler, dblBedeutung, zenBedeutung, zrdNeu, dropLesen, feodoLesen } from "./spamhaus.js";

/* ============================================================
   Sperrlisten für die Mailprüfung (21.10.2026) – die Fachlogik steht in
   src/domain/spamhaus.js, hier nur das Holen.

   FREIE IP-LISTEN (Spamhaus DROP, abuse.ch Feodo Tracker): alle zwölf
   Stunden neu geladen (Spamhaus bittet um höchstens einmal je Stunde).
   Scheitert das Laden, gilt der alte Stand weiter; gab es noch keinen,
   steht im Ergebnis, dass nicht geprüft wurde.

   SPAMHAUS DQS: DNS-Abfragen mit dem Schlüssel aus
   `MAILPRUEFUNG_SPAMHAUS_DQS`. Ohne Schlüssel gibt es die Abfrage nicht.
   `holen` (fetch) und `resolver.a` werden in den Tests vorgespielt.
   ============================================================ */
const DROP_URL = "https://www.spamhaus.org/drop/drop_v4.json";
const FEODO_URL = "https://feodotracker.abuse.ch/downloads/ipblocklist.txt";
const ALLE = 12 * 3600_000;

export function ipListen(holen = fetch, { frist = 10_000 } = {}) {
  let stand = null;          // { bis, drop, feodo }
  let laeuft = null;
  const text = async (url) => {
    const a = await holen(url, { signal: AbortSignal.timeout(frist) });
    if (!a.ok) throw new Error(`HTTP ${a.status}`);
    return a.text();
  };
  async function laden() {
    const [drop, feodo] = await Promise.allSettled([text(DROP_URL), text(FEODO_URL)]);
    const neu = {
      drop: drop.status === "fulfilled" ? dropLesen(drop.value) : stand?.drop || null,
      feodo: feodo.status === "fulfilled" ? feodoLesen(feodo.value) : stand?.feodo || null,
    };
    /* Ein leerer Stand (Seite liefert plötzlich nichts) zählt als Fehler */
    if (neu.drop && !neu.drop.length) neu.drop = stand?.drop || null;
    stand = { bis: Date.now() + (neu.drop && neu.feodo ? ALLE : 3600_000), ...neu };
  }
  return async function ipPruefen(ip) {
    if (!stand || stand.bis < Date.now()) {
      laeuft = laeuft || laden().finally(() => { laeuft = null; });
      await laeuft.catch(() => {});
    }
    if (!stand?.drop && !stand?.feodo) return { geprueft: false };
    if (!ip) return { geprueft: true, treffer: null };
    const d = (stand.drop || []).find((n) => imNetz(ip, n.netz, n.laenge));
    if (d) return { geprueft: true, treffer: { liste: "Spamhaus DROP", kennung: d.kennung, quelle: "© The Spamhaus Project" } };
    if ((stand.feodo || []).includes(ip)) return { geprueft: true, treffer: { liste: "abuse.ch Feodo Tracker", kennung: "", quelle: "abuse.ch (CC0)" } };
    return { geprueft: true, treffer: null };
  };
}

/* Spamhaus DQS. Rückgabe { domains: {d: {art, missbraucht}|null}, zrd: {d: true|false},
   ip: [{liste, art}], ipGeprueft, fehler } – oder null ohne Schlüssel. `ipGeprueft`
   (22.10.2026): ob ZEN gefragt wurde – ohne Rechner und bei IPv6 nicht; sonst
   sähe die Seite ein leeres `ip` als „nicht gelistet". */
export function spamhausAbfrage(resolver, schluessel) {
  if (!schluessel || !dqsName("dbl", "test.example", schluessel)) return null;
  const fragen = async (name) => {
    try { return { a: await resolver.a(name) }; }
    catch (e) { return ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(e?.code) ? { a: [] } : { fehler: e?.code || String(e?.message || e) }; }
  };
  return async function pruefen({ domains = [], ip = "" }) {
    const raus = { domains: {}, zrd: {}, ip: [], ipGeprueft: false, fehler: "" };
    const merkeFehler = (r) => { const f = r.fehler || dqsFehler(r.a); if (f && !raus.fehler) raus.fehler = f; return !f; };
    await Promise.all([
      ...domains.map(async (d) => {
        const [dbl, zrd] = await Promise.all([fragen(dqsName("dbl", d, schluessel)), fragen(dqsName("zrd", d, schluessel))]);
        raus.domains[d] = merkeFehler(dbl) ? dblBedeutung(dbl.a) : null;
        raus.zrd[d] = merkeFehler(zrd) ? zrdNeu(zrd.a) : false;
      }),
      (async () => {
        const name = ip ? dqsName("zen", ip, schluessel) : "";
        if (!name) return;
        const zen = await fragen(name);
        if (merkeFehler(zen)) { raus.ip = zenBedeutung(zen.a); raus.ipGeprueft = true; }
      })(),
    ]);
    return raus;
  };
}
