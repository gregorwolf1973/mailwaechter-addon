import { pruefMailAusEml } from "./regeln/mailPruefungEingabe.js";
import { mailPruefen, dnsAnfrage, RANG, GRUPPEN, URTEIL } from "./regeln/mailPruefung.js";
import { anhangLinksAus } from "./regeln/anhangLinks.js";
import { gleicheOrganisation } from "./regeln/mailDomain.js";
import { kopfAlle } from "./regeln/mailKopfzeilen.js";

/* ============================================================
   Eine Mail prüfen – der Aufrufer der kopierten Regeln (regeln/).

   Das UMFELD, das im Planungstool der Server füllt, füllt hier das Add-on:

     eigene     aus der Option `eigene_domains` (leer = keine)
     eingang    ["mx.google.com"] – Gmail nimmt die Mail an, seine
                Received-Zeile nennt den sendenden Rechner
     bekannte   Map Basisdomain → { mails, zuletzt, name } aus dem
                Gesendet-Ordner und der Option `bekannte_domains`
     kollegen   aus `geschuetzte_namen` (null, wenn leer)
     dns        SPF, DMARC, Domainalter, Sperrlisten (umfeld.js), oder
                null, wenn das Netz nicht antwortet

   DAZU Googles eigenes Urteil (googleBefunde): der OBERSTE
   `Authentication-Results`-Kopf von mx.google.com hat Google selbst
   gesetzt – alles darunter hat der Absender geschrieben und zählt nicht.
   Im Planungstool ist die Aussage des Absendersystems nur eine
   Behauptung (gelb); die von Google ist verlässlich: dmarc=fail oder
   spf=fail mit passender Domain ist rot.
   ============================================================ */

/* Der oberste Authentication-Results-Kopf von mx.google.com, zerlegt. */
export function googleAussage(kopf) {
  const zeile = kopfAlle(kopf, "Authentication-Results").find((w) => /^\s*mx\.google\.com\s*(;|$)/i.test(w));
  if (!zeile) return null;
  const alle = (was) => [...zeile.matchAll(new RegExp(`\\b${was}=(\\w+)`, "gi"))].map((m) => m[1].toLowerCase());
  const feld = (name) => ((zeile.match(new RegExp(`\\b${name.replace(".", "\\.")}=([^\\s;]+)`, "i")) || [])[1] || "").replace(/^<|>$/g, "").toLowerCase();
  const domainVon = (x) => (x.includes("@") ? x.split("@").pop() : x).replace(/[>;]/g, "");
  return {
    spf: alle("spf")[0] || "",
    dkim: alle("dkim"),
    dmarc: alle("dmarc")[0] || "",
    mailfromDomain: domainVon(feld("smtp.mailfrom")),
    headerFrom: domainVon(feld("header.from")),
    dkimDomain: domainVon(feld("header.d")),
    zeile,
  };
}

export function googleBefunde(mail) {
  const g = googleAussage(mail.kopf || []);
  if (!g) return { g: null, befunde: [] };
  const W = "Weg der Mail";
  const von = mail.von?.domain || "";
  const passt = (d) => !d || !von || gleicheOrganisation(d, von);
  const befunde = [];
  if (g.dmarc === "fail" && passt(g.headerFrom)) {
    befunde.push({ gruppe: W, stufe: "rot", titel: "Google: DMARC fehlgeschlagen – Absender gefälscht",
      text: `Gmail hat geprüft und meldet dmarc=fail für ${g.headerFrom || von}: weder SPF noch DKIM stützen die Absenderadresse. Die Mail kommt sehr wahrscheinlich nicht von dem, der sie zu sein vorgibt.` });
  }
  if (g.spf === "fail" && g.mailfromDomain && gleicheOrganisation(g.mailfromDomain, von)) {
    befunde.push({ gruppe: W, stufe: "rot", titel: "Google: SPF fehlgeschlagen für die Absenderdomain",
      text: `Gmail meldet spf=fail: der sendende Rechner darf für ${g.mailfromDomain} nicht senden.` });
  }
  if (g.dkim.includes("fail") && g.dkimDomain && gleicheOrganisation(g.dkimDomain, von)) {
    befunde.push({ gruppe: W, stufe: "gelb", titel: "Google: DKIM-Signatur der Absenderdomain ungültig",
      text: `Gmail meldet dkim=fail für ${g.dkimDomain}: die Mail wurde unterwegs verändert oder die Signatur ist gefälscht.` });
  }
  if (!befunde.length && g.dmarc === "pass") {
    befunde.push({ gruppe: W, stufe: "gruen", titel: "Google bestätigt den Absender (DMARC bestanden)",
      text: `Gmail meldet dmarc=pass für ${g.headerFrom || von}.` });
  }
  return { g, befunde };
}

const stufeVon = (befunde) => (befunde.some((b) => b.stufe === "rot") ? "rot" : befunde.some((b) => b.stufe === "gelb") ? "gelb" : "gruen");

/* bytes = die Rohmail (eml). Rückgabe:
   { stufe, gruende: [{ stufe, gruppe, titel, text }], bericht, mail, dnsFehler, dns } oder
   { stufe: "fehler", fehler } wenn die Mail nicht lesbar ist. */
export async function pruefeMail(bytes, { optionen, bekannte = new Map(), netz = null, heute = undefined } = {}) {
  const mail = pruefMailAusEml(bytes);
  if (!mail) return { stufe: "fehler", fehler: "Mail nicht lesbar", gruende: [] };
  try { mail.anhangLinks = await anhangLinksAus(mail.anhaenge, {}); } catch { mail.anhangLinks = []; }
  const eingang = ["mx.google.com"];
  let dns = null, dnsFehler = "";
  if (netz) {
    try {
      const a = dnsAnfrage(mail, eingang);
      if (a) dns = await netz(a);
    } catch (e) { dnsFehler = String(e?.message || e); }
  }
  const bericht = mailPruefen(mail, {
    eigene: optionen.eigeneDomains,
    eingang,
    bekannte,
    mitApplus: false,
    kollegen: optionen.geschuetzteNamen.length ? optionen.geschuetzteNamen : null,
    dns,
    ...(heute ? { heute } : {}),
  });
  const { g, befunde } = googleBefunde(mail);
  if (befunde.length) {
    bericht.befunde.push(...befunde);
    bericht.befunde.sort((a, b) => GRUPPEN.indexOf(a.gruppe) - GRUPPEN.indexOf(b.gruppe) || RANG[b.stufe] - RANG[a.stufe]);
    bericht.stufe = stufeVon(bericht.befunde);
    bericht.urteil = URTEIL[bericht.stufe];
  }
  bericht.fakten.google = g;
  const gruende = bericht.befunde.filter((b) => b.stufe !== "gruen")
    .map((b) => ({ stufe: b.stufe, gruppe: b.gruppe, titel: b.titel, text: b.text }));
  return { stufe: bericht.stufe, gruende, bericht, mail, dnsFehler, dns };
}

/* Der wichtigste Grund: der erste der schlimmsten Stufe */
export function wichtigsterGrund(gruende, stufe) {
  const g = gruende.find((x) => x.stufe === stufe) || gruende[0];
  return g ? g.titel : "";
}

/* ============================================================
   Der speicherbare Prüfbericht je Mail (ab 0.2.0). Schlank: nur
   Ergebnisse – KEIN Mailtext (lesetext/html/text), keine Rohkopfzeilen.
   Ziel unter 8 KB je Mail, harte Begrenzung in begrenzen().
   ============================================================ */
export const BERICHT_MAX_BYTES = 8192;
const kuerzen = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const mehrzahl = (n, eins, viele) => `${n} ${n === 1 ? eins : viele}`;

export function geprueftListe(ergebnis) {
  const b = ergebnis.bericht;
  const f = b.fakten || {};
  const g = f.google || null;
  const dns = ergebnis.dns || null;
  const liste = [];
  liste.push(g ? `Google-Prüfung: SPF ${g.spf || "–"}, DKIM ${(g.dkim || []).join("/") || "–"}, DMARC ${g.dmarc || "–"}` : "Google-Prüfung: kein Authentication-Results von mx.google.com vorhanden");
  if (dns) {
    liste.push(f.spf ? `SPF nachgeprüft: ${f.spf.ergebnis}${f.spf.domain ? " für " + f.spf.domain : ""}` : "SPF nachgeprüft: ohne Ergebnis");
    liste.push(f.dmarc?.p ? `DMARC im DNS: p=${f.dmarc.p}` : "DMARC im DNS: kein Eintrag");
    const dom = Object.values(dns.domains || {});
    liste.push(dom.length ? `Domain-Existenz geprüft (${dom.length})` : "Domain-Existenz nicht geprüft");
    const al = Object.values(dns.alter || {});
    liste.push(al.some((a) => a?.registriert) ? "Domainalter geprüft" : al.length ? "Domainalter nicht ermittelbar" : "Domainalter nicht geprüft");
    const sh = f.sperrlisten?.spamhaus;
    liste.push(sh?.zustand === "geprueft" ? "Sperrlisten geprüft (Spamhaus" + (f.sperrlisten.frei === "aus" || f.sperrlisten.frei === "nicht geladen" ? "" : ", DROP/Feodo") + ")" : "Sperrlisten: Stand nicht abrufbar");
  } else {
    liste.push(`Nicht geprüft: SPF, Domainalter, Sperrlisten (DNS nicht erreichbar${ergebnis.dnsFehler ? ": " + kuerzen(ergebnis.dnsFehler, 80) : ""})`);
  }
  liste.push(mehrzahl(b.links.length, "Link", "Links") + ", " + mehrzahl(b.anhaenge.length, "Anhang", "Anhänge"));
  liste.push(b.umfeld?.archiv ? "bekannte Absender aus Gesendet: ja" : "bekannte Absender aus Gesendet: nein");
  return liste;
}

function einzelheitenVon(ergebnis) {
  const { mail: m, bericht: b } = ergebnis;
  const f = b.fakten || {};
  const g = f.google || null;
  const e = {};
  const adr = (x) => (x?.name ? `${x.name} <${x.adresse}>` : x?.adresse || "");
  if (m?.von) e.absender = kuerzen(adr(m.von), 200);
  if (m?.antwortAn) e.antwortAn = kuerzen(m.antwortAn.adresse, 200);
  if (m?.returnPath) e.returnPath = kuerzen(m.returnPath, 200);
  if (g?.mailfromDomain) e.mailfrom = g.mailfromDomain;
  if (f.eingang?.ip) e.rechner = { ip: f.eingang.ip, name: kuerzen(f.eingang.name || "", 100), helo: kuerzen(f.eingang.helo || "", 100) };
  if (f.spf) e.spf = kuerzen(`${f.spf.ergebnis} für ${f.spf.domain || "?"}${f.spf.begriff ? " · " + f.spf.begriff : ""}`, 200);
  if (f.dmarc?.p) e.dmarc = `p=${f.dmarc.p} (${f.dmarc.domain})`;
  if (g) e.google = { spf: g.spf, dkim: (g.dkim || []).join(", "), dmarc: g.dmarc };
  if (m?.gesendet) e.datum = new Date(m.gesendet).toISOString();
  return e;
}

/* Hält das Objekt unter max Bytes: erst Links und Texte kürzen, dann Links
   streichen. Befunde bleiben immer vollständig in der Zahl. */
function begrenzen(b, max) {
  const groesse = () => Buffer.byteLength(JSON.stringify(b), "utf8");
  if (groesse() <= max) return b;
  b.gekuerzt = true;
  for (const l of b.links) { l.ziel = kuerzen(l.ziel, 100); l.anzeige = kuerzen(l.anzeige, 60); }
  while (groesse() > max && b.links.length > 5) b.links.length = Math.max(5, Math.floor(b.links.length * 0.7));
  if (groesse() > max) for (const x of b.befunde) x.text = kuerzen(x.text, 300);
  if (groesse() > max) for (const x of b.befunde) x.text = kuerzen(x.text, 120);
  if (groesse() > max) for (const a of b.anhaenge) a.gruende = a.gruende.slice(0, 1);
  while (groesse() > max && b.links.length > 0) b.links.length = Math.floor(b.links.length / 2);
  while (groesse() > max && b.anhaenge.length > 5) b.anhaenge.length = 5;
  return b;
}

export function berichtKompakt(ergebnis, max = BERICHT_MAX_BYTES) {
  const b = ergebnis.bericht;
  const links = (b.links || []).slice(0, 50).map((l) => ({
    anzeige: kuerzen(l.text, 120),
    ziel: kuerzen(l.ziel, 200),
    stufe: l.stufe || "gruen",
    gruende: (l.befunde || []).map((x) => kuerzen(x.titel, 120)),
  }));
  const anhaenge = (b.anhaenge || []).map((a) => ({
    name: kuerzen(a.name, 120),
    groesse: a.groesse || 0,
    stufe: a.stufe || "gruen",
    gruende: b.befunde.filter((x) => x.gruppe === "Anhänge" && String(x.text).includes(a.name)).map((x) => kuerzen(x.titel, 120)),
  }));
  const kompakt = {
    urteil: b.urteil,
    stufe: b.stufe,
    befunde: b.befunde.map((x) => ({ gruppe: x.gruppe, stufe: x.stufe, titel: kuerzen(x.titel, 200), text: kuerzen(x.text, 600) })),
    geprueft: geprueftListe(ergebnis),
    linksGesamt: (b.links || []).length,
    links,
    anhaenge,
    einzelheiten: einzelheitenVon(ergebnis),
  };
  return begrenzen(kompakt, max);
}
