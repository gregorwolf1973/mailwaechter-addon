/* kopiert aus planungstool (src/domain/spf.js), nicht hier ändern – scripts/regeln-holen.mjs */
import { basisDomain } from "./mailDomain.js";

/* ============================================================
   SPF und DMARC nachprüfen – für die Mailprüfung (19.10.2026)

   SPF beantwortet EINE Frage: darf der Rechner mit dieser Adresse Mail
   für diese Domain verschicken? Die Domain sagt es selbst, in einem
   TXT-Eintrag im DNS (`v=spf1 include:spf.protection.outlook.com -all`).

   Warum wir das selbst tun: unsere Sophos-Firewall prüft SPF nicht
   (siehe domain/mailKopfzeilen.js), und was in den Kopfzeilen als
   Ergebnis steht, hat der Absender geschrieben. Die Adresse, gegen die
   geprüft wird, kommt aus der Zeile, in der UNSER Eingang die Mail
   angenommen hat.

   DER RESOLVER WIRD ÜBERGEBEN: { txt, a, aaaa, mx } – jede Funktion
   gibt ein Promise zurück und wirft bei „gibt es nicht" einen Fehler
   mit `code` ENOTFOUND/ENODATA. So ist die Auswertung ohne Netz
   prüfbar, und der Server reicht nur `node:dns` hinein.

   MAKROS WERDEN AUFGELÖST (RFC 7208, Abschnitt 7) – seit dem
   19.10.2026. Bis dahin stand hier, sie kämen „fast nur in exists" vor
   und ein Begriff mit Makro zähle als kein Treffer. Das war falsch und
   hat eine echte Mail von perrigo.com gelb gemacht: Proofpoint, der
   Maildienst vieler großer Firmen, veröffentlicht
   `include:%{ir}.%{v}.%{d}.spf.has.pphosted.com` und antwortet je
   Adresse mit einem eigenen Eintrag. Übersprungen fiel die Prüfung auf
   `~all` zurück: „nicht sicher zugelassen", obwohl der Rechner es war.

   Was ein Makro braucht, das wir nicht haben – `%{s}` und `%{l}` wollen
   den Teil der Absenderadresse vor dem @, und der geht bewusst nicht an
   den Server –, macht den Begriff UNBESTIMMT. Endet die Prüfung dann
   negativ, heißt das Ergebnis „neutral" mit Begründung, nie „fail":
   ein Verdacht, den wir uns selbst eingeredet haben, ist schlimmer als
   eine offene Frage.

   `ptr` (veraltet, RFC 7208 rät ab) zählt als kein Treffer – das führt
   höchstens zu „neutral" statt „pass", nie zu einem falschen „fail".

   DKIM WIRD NICHT GEPRÜFT. Dafür braucht es die Mail Byte für Byte so,
   wie sie ankam; eine .msg aus Outlook hat sie nicht mehr.
   ============================================================ */

const KEIN_EINTRAG = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ENONAME"]);
const istLeer = (e) => KEIN_EINTRAG.has(e?.code);
const GRENZE_ABFRAGEN = 10; /* RFC 7208, 4.6.4 */

/* IPv4 und IPv6 als Zahl, damit ein Netz ein einfacher Vergleich wird. */
export function ipZerlegen(ip) {
  const s = String(ip || "").trim();
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const teile = v4.slice(1).map(Number);
    if (teile.some((t) => t > 255)) return null;
    return { v: 4, wert: teile.reduce((n, t) => n * 256n + BigInt(t), 0n) };
  }
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  let [links, rechts] = s.split("::");
  if (s.split("::").length > 2) return null;
  /* Ein eingebettetes IPv4 am Ende (::ffff:1.2.3.4) in zwei Gruppen umrechnen. */
  const v4Ende = (teil) => {
    const m = teil.match(/^(.*?)(\d+\.\d+\.\d+\.\d+)$/);
    if (!m) return teil;
    const n = ipZerlegen(m[2]);
    if (!n) return teil;
    const w = Number(n.wert);
    return m[1] + ((w >>> 16) & 0xffff).toString(16) + ":" + (w & 0xffff).toString(16);
  };
  if (rechts !== undefined) rechts = v4Ende(rechts); else links = v4Ende(links);
  const a = links ? links.split(":") : [];
  const b = rechts ? rechts.split(":") : [];
  const fehlt = 8 - a.length - b.length;
  if (rechts === undefined ? a.length !== 8 : fehlt < 1) return null;
  const gruppen = [...a, ...Array(rechts === undefined ? 0 : fehlt).fill("0"), ...b];
  if (gruppen.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v: 6, wert: gruppen.reduce((n, g) => n * 65536n + BigInt(parseInt(g, 16)), 0n) };
}

export function imNetz(ip, netz, laenge) {
  const a = typeof ip === "string" ? ipZerlegen(ip) : ip;
  const b = typeof netz === "string" ? ipZerlegen(netz) : netz;
  if (!a || !b || a.v !== b.v) return false;
  const bits = a.v === 4 ? 32 : 128;
  const l = laenge === undefined || laenge === null || isNaN(laenge) ? bits : Math.min(bits, Math.max(0, laenge));
  const schieben = BigInt(bits - l);
  return (a.wert >> schieben) === (b.wert >> schieben);
}

/* TXT-Einträge kommen in Stücken zu je 255 Zeichen – zusammensetzen. */
async function txtHolen(resolver, name) {
  const roh = await resolver.txt(name);
  return roh.map((r) => (Array.isArray(r) ? r.join("") : String(r)));
}

/* Den einen SPF-Eintrag finden. Zwei sind ein Fehler der Domain (RFC 7208, 4.5). */
export function spfDatensatz(txts) {
  const spf = txts.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (spf.length > 1) return { fehler: "mehrere SPF-Einträge" };
  return spf.length ? { datensatz: spf[0].trim() } : null;
}

const QUALIFIER = { "+": "pass", "-": "fail", "~": "softfail", "?": "neutral" };

/* ------------------------------------------------------------------
   Makros auflösen (RFC 7208, 7). `k`: { ipObj, ip, domain (die gerade
   geprüfte), absenderDomain, helo }. Rückgabe: der Text, oder null,
   wenn ein Makro etwas braucht, das wir nicht kennen.

     %{i}  die Adresse (IPv6 als Nibbles mit Punkten)   %{ir} umgedreht
     %{d}  die geprüfte Domain   %{o} die Absenderdomain   %{h} HELO
     %{v}  „in-addr" bzw. „ip6"   %{p} „unknown" (erlaubt, RFC 7208 7.3)
     Ziffern: nur die rechten N Teile; Großbuchstabe: URL-kodiert;
     %% %_ %- sind Prozent, Leerzeichen, „%20".
   ------------------------------------------------------------------ */
export function makroAufloesen(text, k) {
  let unbekannt = false;
  const raus = String(text).replace(/%(?:(%)|(_)|(-)|\{([a-zA-Z])(\d*)(r?)([.\-+,/_=]*)\})/g,
    (ganz, prozent, unter, strich, buchstabe, ziffern, umkehr, trenner) => {
      if (prozent) return "%";
      if (unter) return " ";
      if (strich) return "%20";
      const b = buchstabe.toLowerCase();
      let wert = "";
      if (b === "i") wert = k.ipObj.v === 4 ? k.ip : k.ipObj.wert.toString(16).padStart(32, "0").split("").join(".");
      else if (b === "d") wert = k.domain;
      else if (b === "o") wert = k.absenderDomain;
      else if (b === "v") wert = k.ipObj.v === 4 ? "in-addr" : "ip6";
      else if (b === "p") wert = "unknown";
      else if (b === "h" && k.helo) wert = k.helo;
      else { unbekannt = true; return ganz; }
      const zeichen = (trenner || ".").replace(/[-\\\]^]/g, "\\$&");
      let teile = wert.split(new RegExp(`[${zeichen}]`));
      if (umkehr) teile.reverse();
      if (ziffern && Number(ziffern) > 0) teile = teile.slice(-Number(ziffern));
      const s = teile.join(".");
      return buchstabe === buchstabe.toUpperCase() ? encodeURIComponent(s) : s;
    });
  return unbekannt ? null : raus;
}

async function adressen(resolver, host, ipObj) {
  try {
    return ipObj.v === 4 ? await resolver.a(host) : await resolver.aaaa(host);
  } catch (e) {
    if (istLeer(e)) return [];
    throw e;
  }
}

async function auswerten(resolver, domain, ipObj, zustand, tiefe) {
  if (tiefe > 10) return { ergebnis: "permerror", grund: "zu tief verschachtelt" };
  let txts;
  try { txts = await txtHolen(resolver, domain); } catch (e) {
    if (istLeer(e)) return { ergebnis: "none", domain };
    return { ergebnis: "temperror", grund: e?.code || "DNS-Fehler", domain };
  }
  const gefunden = spfDatensatz(txts);
  if (!gefunden) return { ergebnis: "none", domain };
  if (gefunden.fehler) return { ergebnis: "permerror", grund: gefunden.fehler, domain };
  const begriffe = gefunden.datensatz.split(/\s+/).slice(1).filter(Boolean);
  let umleitung = "";
  try {
    for (const begriff of begriffe) {
      const m = begriff.match(/^([+\-~?]?)(all|include|a|mx|ptr|ip4|ip6|exists)(?::([^/]+))?(?:\/(\d+))?(?:\/\/(\d+))?$/i);
      if (!m) {
        const mod = begriff.match(/^([a-z][\w.-]*)=(.*)$/i);
        if (mod && mod[1].toLowerCase() === "redirect") umleitung = mod[2];
        else if (!mod) return { ergebnis: "permerror", grund: `unbekannter Begriff „${begriff}“`, domain, datensatz: gefunden.datensatz };
        continue;
      }
      const [, q, artRoh, arg, l4, l6] = m;
      const art = artRoh.toLowerCase();
      const ziel = arg ? makroAufloesen(arg, { ...zustand.kontext, domain }) : domain;
      if (ziel === null) { zustand.unbestimmt = begriff; continue; } /* siehe Kopf */
      const laenge = art === "ip4" || art === "ip6" ? (l4 ? +l4 : undefined)
        : ipObj.v === 4 ? (l4 ? +l4 : 32) : (l6 ? +l6 : 128);
      let treffer = false;
      if (art === "all") treffer = true;
      else if (art === "ip4" || art === "ip6") treffer = imNetz(ipObj, ziel, laenge);
      else {
        if (++zustand.abfragen > GRENZE_ABFRAGEN) return { ergebnis: "permerror", grund: "mehr als 10 DNS-Abfragen", domain };
        if (art === "a") treffer = (await adressen(resolver, ziel, ipObj)).some((x) => imNetz(ipObj, x, laenge));
        else if (art === "mx") {
          let mx = [];
          try { mx = await resolver.mx(ziel); } catch (e) { if (!istLeer(e)) throw e; }
          for (const eintrag of mx.slice(0, 10)) {
            if ((await adressen(resolver, eintrag.exchange, ipObj)).some((x) => imNetz(ipObj, x, laenge))) { treffer = true; break; }
          }
        } else if (art === "exists") {
          try { treffer = (await resolver.a(ziel)).length > 0; } catch (e) { if (!istLeer(e)) throw e; }
        } else if (art === "include") {
          const r = await auswerten(resolver, ziel, ipObj, zustand, tiefe + 1);
          if (r.ergebnis === "none") return { ergebnis: "permerror", grund: `include:${ziel} ohne SPF-Eintrag`, domain };
          if (r.ergebnis === "permerror" || r.ergebnis === "temperror") return { ...r, domain };
          treffer = r.ergebnis === "pass";
        }
        /* ptr: kein Treffer – siehe Kopf */
      }
      if (treffer) return { ergebnis: QUALIFIER[q || "+"], begriff, domain, datensatz: gefunden.datensatz };
    }
    if (umleitung) {
      if (++zustand.abfragen > GRENZE_ABFRAGEN) return { ergebnis: "permerror", grund: "mehr als 10 DNS-Abfragen", domain };
      const ziel = makroAufloesen(umleitung, { ...zustand.kontext, domain });
      if (ziel === null) { zustand.unbestimmt = "redirect=" + umleitung; return { ergebnis: "neutral", domain, datensatz: gefunden.datensatz }; }
      const r = await auswerten(resolver, ziel, ipObj, zustand, tiefe + 1);
      return r.ergebnis === "none" ? { ergebnis: "permerror", grund: `redirect=${ziel} ohne SPF-Eintrag`, domain } : { ...r, domain };
    }
  } catch (e) {
    return { ergebnis: "temperror", grund: e?.code || "DNS-Fehler", domain };
  }
  return { ergebnis: "neutral", domain, datensatz: gefunden.datensatz };
}

/* Der eine Aufruf: { ergebnis, domain, begriff?, datensatz?, grund? }.
   `helo` ist optional und nur für das Makro %{h} da. */
export async function spfPruefen({ ip, domain, helo = "" }, resolver) {
  const ipObj = ipZerlegen(ip);
  if (!ipObj) return { ergebnis: "none", grund: "keine gültige Adresse", domain };
  if (!domain) return { ergebnis: "none", grund: "keine Domain", domain };
  const d = String(domain).toLowerCase();
  const zustand = { abfragen: 0, unbestimmt: "", kontext: { ip: String(ip).trim(), ipObj, absenderDomain: d, helo: String(helo || "").toLowerCase() } };
  const r = await auswerten(resolver, d, ipObj, zustand, 0);
  /* Ein Begriff blieb unbestimmt, und es ging negativ aus: dann wissen
     wir es nicht – siehe Kopf. */
  if (zustand.unbestimmt && ["fail", "softfail", "neutral"].includes(r.ergebnis)) {
    return { ...r, ergebnis: "neutral", grund: `„${zustand.unbestimmt}“ braucht Angaben, die hier nicht vorliegen (Absenderadresse vor dem @ oder HELO)` };
  }
  return r;
}

/* ------------------------------------------------------------------
   DMARC: was die Domain für den Fall verlangt, dass jemand sie fälscht.
   `p=reject` heißt „wegwerfen", `quarantine` „in den Spam", `none`
   „nur beobachten". Gesucht wird bei der Domain selbst und ersatzweise
   bei ihrer Organisation (RFC 7489, 6.6.3).
   ------------------------------------------------------------------ */
export function dmarcLesen(txts) {
  const roh = txts.find((t) => /^v=DMARC1\s*(;|$)/i.test(t.trim()));
  if (!roh) return null;
  const werte = {};
  for (const teil of roh.split(";")) {
    const [k, ...v] = teil.split("=");
    if (k && v.length) werte[k.trim().toLowerCase()] = v.join("=").trim();
  }
  return {
    p: (werte.p || "none").toLowerCase(), sp: (werte.sp || werte.p || "none").toLowerCase(),
    adkim: werte.adkim === "s" ? "s" : "r", aspf: werte.aspf === "s" ? "s" : "r",
    pct: werte.pct ? +werte.pct : 100, datensatz: roh.trim(),
  };
}

export async function dmarcSuchen(domain, resolver) {
  const d = String(domain || "").toLowerCase();
  if (!d) return null;
  for (const wo of [...new Set([d, basisDomain(d)])]) {
    try {
      const r = dmarcLesen(await txtHolen(resolver, "_dmarc." + wo));
      if (r) return { ...r, domain: wo, organisation: wo !== d };
    } catch (e) {
      if (!istLeer(e)) return { fehler: e?.code || "DNS-Fehler", domain: wo };
    }
  }
  return null;
}

/* Gibt es die Domain überhaupt? Eine Antwortadresse auf eine Domain
   ohne MX und ohne A kann keine Mail empfangen – oder sie ist frisch
   und noch nicht eingerichtet. */
export async function domainLebt(domain, resolver) {
  let mx = 0, a = false, fehler = "";
  try { mx = (await resolver.mx(domain)).length; } catch (e) { if (!istLeer(e)) fehler = e?.code || "DNS-Fehler"; }
  if (!mx) {
    try { a = (await resolver.a(domain)).length > 0; } catch (e) { if (!istLeer(e)) fehler = fehler || e?.code || "DNS-Fehler"; }
  }
  return { mx, a, gibtEs: mx > 0 || a, fehler };
}
