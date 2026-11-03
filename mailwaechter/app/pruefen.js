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
   { stufe, gruende: [{ stufe, gruppe, titel, text }], bericht, mail } oder
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
  return { stufe: bericht.stufe, gruende, bericht, mail, dnsFehler };
}

/* Der wichtigste Grund: der erste der schlimmsten Stufe */
export function wichtigsterGrund(gruende, stufe) {
  const g = gruende.find((x) => x.stufe === stufe) || gruende[0];
  return g ? g.titel : "";
}
