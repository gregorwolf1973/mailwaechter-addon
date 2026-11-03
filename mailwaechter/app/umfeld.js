import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { spfPruefen, dmarcSuchen, domainLebt } from "./regeln/spf.js";
import { basisDomain, istFreemail, gleicheOrganisation } from "./regeln/mailDomain.js";
import { rdapBasis, registriertAus } from "./regeln/domainAlter.js";
import { ipListen } from "./regeln/sperrlisten.js";

/* ============================================================
   Was nur das Netz beantworten kann: SPF, DMARC, "gibt es die Domain",
   Alter der Domain (RDAP), Sperrlisten DROP und Feodo.

   Entspricht server/mailPruefung.js im Planungstool (dnsPruefen,
   rdapAbfrage) – dort hängt es an Datenbank und AP+, deshalb hier neu
   zusammengesteckt; die Fachlogik (spf.js, domainAlter.js, sperrlisten.js)
   ist kopiert. Hinaus gehen NUR Domainnamen und die Adresse des sendenden
   Rechners, nie ein Mailinhalt. Spamhaus DQS (braucht Schlüssel) entfällt.
   ============================================================ */

const mitFrist = (versprechen, ms, ersatz) => {
  let uhr;
  const frist = new Promise((ok) => { uhr = setTimeout(() => ok(ersatz), ms); });
  return Promise.race([versprechen, frist]).finally(() => clearTimeout(uhr));
};

export const resolverAus = (r) => ({
  txt: (n) => r.resolveTxt(n),
  a: (n) => r.resolve4(n),
  aaaa: (n) => r.resolve6(n),
  mx: (n) => r.resolveMx(n),
});

const IANA_RDAP = "https://data.iana.org/rdap/dns.json";
export function rdapAbfrage(holen = fetch, { frist = 6000 } = {}) {
  let bootstrap = null;
  const speicher = new Map();
  const json = async (url) => {
    const a = await holen(url, { headers: { Accept: "application/rdap+json, application/json" }, signal: AbortSignal.timeout(frist) });
    if (!a.ok) throw Object.assign(new Error(`HTTP ${a.status}`), { status: a.status });
    return a.json();
  };
  return async function alterVon(domain) {
    const basis = basisDomain(domain);
    const da = speicher.get(basis);
    if (da && da.bis > Date.now()) return da.wert;
    let wert;
    try {
      if (!bootstrap || bootstrap.bis < Date.now()) bootstrap = { bis: Date.now() + 24 * 3600_000, wert: await json(IANA_RDAP) };
      const url = rdapBasis(bootstrap.wert, basis);
      if (!url) wert = { ohneDatum: true, grund: "keine RDAP-Stelle für diese Endung" };
      else {
        const registriert = registriertAus(await json(`${url}domain/${encodeURIComponent(basis)}`));
        wert = registriert ? { registriert } : { ohneDatum: true };
      }
    } catch (e) {
      wert = { fehler: e?.status === 404 ? "bei der Registrierungsstelle unbekannt" : String(e?.message || e) };
    }
    if (speicher.size > 1000) speicher.clear();
    speicher.set(basis, { bis: Date.now() + (wert.fehler ? 3600_000 : 24 * 3600_000), wert });
    return wert;
  };
}

/* Die DNS-Antwort für eine Mail – dieselbe Form wie /api/mailpruefung/dns
   im Planungstool. Die Anfrage kommt aus dnsAnfrage() (regeln/mailPruefung.js). */
export async function dnsPruefen({ ip, mailfrom, von, helo = "", weitere = [] }, resolver, { eigene = [], alterVon = null, ipPruefen = null, frist = 8000 } = {}) {
  const spf = ip && (mailfrom || von)
    ? mitFrist(spfPruefen({ ip, domain: mailfrom || von, helo }, resolver), frist, { ergebnis: "temperror", grund: "Zeitüberschreitung", domain: mailfrom || von })
    : Promise.resolve(null);
  const dmarc = von ? mitFrist(dmarcSuchen(von, resolver), frist, { fehler: "Zeitüberschreitung" }) : Promise.resolve(null);
  const namen = [...new Set([von, ...weitere].filter(Boolean))];
  const lebt = namen.map((d) => mitFrist(domainLebt(d, resolver), frist, { gibtEs: true, mx: 0, a: false, fehler: "Zeitüberschreitung" }));
  const fremd = (d) => !istFreemail(d) && !eigene.some((e) => gleicheOrganisation(e, d));
  const alterNamen = alterVon ? [...new Set(namen.filter(fremd).map(basisDomain))] : [];
  const alter = alterNamen.map((d) => mitFrist(alterVon(d), frist, { fehler: "Zeitüberschreitung" }));
  const sperre = ipPruefen && ip ? mitFrist(ipPruefen(ip), frist, { geprueft: false }) : Promise.resolve(undefined);
  const [s, d, sp, ...rest] = await Promise.all([spf, dmarc, sperre, ...lebt, ...alter]);
  const l = rest.slice(0, lebt.length), al = rest.slice(lebt.length);
  return {
    spf: s, dmarc: d, domains: Object.fromEntries(namen.map((n, i) => [n, l[i]])),
    ...(alterVon ? { alter: Object.fromEntries(alterNamen.map((n, i) => [n, al[i]])) } : {}),
    ...(sp ? { sperre: sp } : {}),
  };
}

/* Die Netzabfragen für den Betrieb, mit Zwischenspeicher (10 Minuten je
   Anfrage, wie im Planungstool). */
export function netzAbfragen(optionen, { resolver = null, holen = fetch } = {}) {
  let r = resolver;
  if (!r) r = resolverAus(new Resolver({ timeout: 2500, tries: 2 }));
  const alterVon = optionen.rdap ? rdapAbfrage(holen) : null;
  const ipPruefen = optionen.sperrlisten ? ipListen(holen) : null;
  const speicher = new Map();
  return async function abfragen(anfrage) {
    if (anfrage.ip && !isIP(anfrage.ip)) anfrage = { ...anfrage, ip: "" };
    const schluessel = JSON.stringify(anfrage);
    const da = speicher.get(schluessel);
    if (da && da.bis > Date.now()) return da.wert;
    const wert = await dnsPruefen(anfrage, r, { eigene: optionen.eigeneDomains, alterVon, ipPruefen });
    if (speicher.size > 500) speicher.clear();
    speicher.set(schluessel, { bis: Date.now() + 10 * 60_000, wert });
    return wert;
  };
}
