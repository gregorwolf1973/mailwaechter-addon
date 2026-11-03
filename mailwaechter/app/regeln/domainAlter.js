/* kopiert aus planungstool (src/domain/domainAlter.js), nicht hier ändern – scripts/regeln-holen.mjs */
/* ============================================================
   Wie alt ist eine Domain? (21.10.2026, Gregor Wolf)

   „kann die Mailprüfung auch prüfen ob die mail eine fakemail ist oder
   bei whoami um zu erkennen, das es ein fake ist." Anlass war eine Mail,
   bei der ALLES grün war: eigene Domain, Versand über Google, SPF
   bestanden, DMARC eingerichtet, keine Links, kein Anhang. Die Domain
   war fünf Wochen alt. So sehen Betrüger aus, die es richtig machen:
   Domain kaufen, Postfach einrichten, freundlich schreiben.

   Gefragt wird per RDAP – dem Nachfolger von WHOIS, mit JSON statt
   Freitext. Welcher Server für eine Endung zuständig ist, sagt die
   IANA (`https://data.iana.org/rdap/dns.json`). Die Abfrage stellt der
   Server (server/mailPruefung.js); hier steht nur, was sich ohne Netz
   rechnen lässt.

   NICHT JEDE ENDUNG VERRÄT DAS ALTER. Die DENIC (.de) gibt das
   Registrierungsdatum nicht heraus; dann sagt der Bericht das, statt zu
   schweigen.
   ============================================================ */

/* Ab wann ist eine Domain „neu"? Unter 30 Tagen ist sie bei einem
   Absender, den wir nicht kennen, ein starkes Zeichen; unter 180 Tagen
   ein Grund, genau hinzusehen. */
export const ALTER_ROT = 30;
export const ALTER_GELB = 180;

/* Der RDAP-Server einer Domain aus der IANA-Liste
   ({ services: [[["com","net"], ["https://rdap.verisign.com/com/v1/"]], …] }) */
export function rdapBasis(bootstrap, domain) {
  const tld = String(domain || "").toLowerCase().split(".").pop();
  if (!tld) return "";
  for (const [endungen, urls] of bootstrap?.services || []) {
    if (!(endungen || []).map((e) => String(e).toLowerCase()).includes(tld)) continue;
    const url = (urls || []).find((u) => /^https:\/\//i.test(u)) || (urls || [])[0] || "";
    return url ? (url.endsWith("/") ? url : url + "/") : "";
  }
  return "";
}

/* Das Registrierungsdatum aus einer RDAP-Antwort – JJJJ-MM-TT oder "" */
export function registriertAus(rdap) {
  const e = (rdap?.events || []).find((x) => String(x?.eventAction || "").toLowerCase() === "registration");
  const d = String(e?.eventDate || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
}

/* Ganze Tage zwischen zwei Daten (JJJJ-MM-TT), nie negativ */
export function tageSeit(datum, heute) {
  const a = Date.UTC(+datum.slice(0, 4), +datum.slice(5, 7) - 1, +datum.slice(8, 10));
  const b = Date.UTC(+heute.slice(0, 4), +heute.slice(5, 7) - 1, +heute.slice(8, 10));
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/* „vor 39 Tagen", „vor 5 Monaten", „seit 2009" – für den Bericht */
export function alterText(tage, datum) {
  if (tage < 60) return `vor ${tage} ${tage === 1 ? "Tag" : "Tagen"}`;
  if (tage < 730) return `vor ${Math.round(tage / 30.4)} Monaten`;
  return `seit ${datum.slice(0, 4)}`;
}

/* Die Stufe für eine Domain dieses Alters. Bekannte Absender (AP+,
   Mailindex) sind nicht verdächtig, nur weil ihre Domain neu ist – eine
   Umfirmierung kommt vor; bei ihnen reicht ein Hinweis. */
export function alterStufe(tage, bekannt) {
  if (tage < ALTER_ROT) return bekannt ? "gelb" : "rot";
  if (tage < ALTER_GELB) return bekannt ? "info" : "gelb";
  return "info";
}
