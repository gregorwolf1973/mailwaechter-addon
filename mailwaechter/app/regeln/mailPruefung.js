/* kopiert aus planungstool (src/domain/mailPruefung.js), nicht hier ändern – scripts/regeln-holen.mjs, mit kleinen Ersetzungen für Gmail */
import {
  EIGENE_DOMAINS, basisDomain, gleicheOrganisation, aehnlicheDomain, vorlagenAus, istFreemail, hatPunycode, hostLesbar, missbrauchteEndung,
} from "./mailDomain.js";
import { EINGANG_HOSTS, eingangFinden, exchangeAngaben, sophosAngaben, absenderBehauptung } from "./mailKopfzeilen.js";
import { linksAus, linkPruefen, htmlZuText, linkEntpacken, hostAus } from "./mailLinks.js";
import { anhaengePruefen } from "./mailAnhangPruefung.js";
import { inhaltPruefen, eigenerTeil } from "./mailInhaltPruefung.js";
import { ibansAus, ibanLesbar, isoAusKfz, landName, IBAN_LAENGE, ibanPruefsumme } from "./iban.js";
import { tageSeit, alterText, alterStufe, ALTER_GELB } from "./domainAlter.js";

/* ============================================================
   Die Mailprüfung – aus allen Einzelbefunden ein Urteil (19.10.2026)

   Eingabe: eine Mail in der Form aus domain/mailPruefungEingabe.js und
   das UMFELD, das nur der Server kennt:

     bekannte   Map Basisdomain → { mails, zuletzt, name, laender, rolle, ibans } – aus
                dem AP+-Adressstamm (Firmenname, Länder als Kfz-Kennzeichen,
                Lieferant/Kunde), dem Mailindex (mails, zuletzt) und der
                IBAN-Liste der Buchhaltung (`ibans`: Prüfsummen, siehe
                ibanPruefsumme); null = nicht verfügbar
     mitApplus  ob der AP+-Adressstamm in `bekannte` steckt – davon hängt
                ab, was „nicht bekannt" heißen darf
     kollegen   Namen aus dem Mitarbeiterstamm (null = nicht verfügbar)
     dns        { spf, dmarc, domains, alter, sperre, spamhaus } von
                /api/mailpruefung/dns (null = nicht geprüft);
                `alter` je Basisdomain { registriert: "JJJJ-MM-TT" } oder
                { ohneDatum: true } / { fehler } – domain/domainAlter.js;
                `sperre` { geprueft, treffer } für den sendenden Rechner
                (Spamhaus DROP, Feodo); `spamhaus` { domains, zrd, ip,
                ipGeprueft, fehler } aus Spamhaus DQS – domain/spamhaus.js
     heute      JJJJ-MM-TT für das Alter der Domain (Vorgabe: heute; für Tests)

   Ohne Server läuft alles, was die Mail selbst verrät; die Prüfungen,
   die ein Umfeld brauchen, fallen dann weg und der Bericht sagt das.

   DIE STUFEN: rot (gefährlich), gelb (verdächtig), info (zur Kenntnis),
   gruen (spricht für die Mail). Das Urteil ist die schlimmste Stufe –
   es wird NICHT gezählt oder gewichtet. Drei gelbe Hinweise sind kein
   rotes Urteil; dafür gibt es die KOMBINATIONEN unten, die genau die
   Maschen beschreiben, die eine Firma treffen.

   EIN GRÜNES URTEIL IST KEINE GARANTIE, und der Bericht sagt das
   jedes Mal. Wer ein echtes Postfach eines Lieferanten übernommen hat,
   schreibt von der echten Domain.
   ============================================================ */

export const RANG = { rot: 3, gelb: 2, info: 1, gruen: 0 };
export const GRUPPEN = ["Absender", "Weg der Mail", "Links", "Anhänge", "Inhalt"];

const normName = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/ß/g, "ss").split(/[^a-z]+/).filter((w) => w.length > 1);

/* Steht der Name eines Kollegen im Anzeigenamen? Alle Namensteile
   müssen vorkommen („Wolf, Gregor" trifft „Gregor Wolf"); Namen aus
   einem Wort zählen nicht – „Martin" allein trifft zu viele. */
export function kollegeImNamen(anzeige, kollegen) {
  const woerter = new Set(normName(anzeige));
  for (const k of kollegen || []) {
    const teile = normName(k);
    if (teile.length >= 2 && teile.every((t) => woerter.has(t))) return k;
  }
  return "";
}

/* Steht der Name eines Kollegen VOR DEM @ (28.10.2026)? Ohne
   Anzeigenamen kam `gregor.wolf@fremd.com` sonst durch. Gezählt wird
   „gregor.wolf", „wolf_gregor", „gregor-wolf73" und „gregorwolf" – alle
   Namensteile, Ziffern am Ende egal. Umlaute in beiden Schreibweisen
   („mueller" und „muller"). Kürzel wie „g.wolf" zählen nicht: zu viele
   Fremde heißen so. */
const umschrift = (s) => String(s || "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
export function kollegeInAdresse(adresse, kollegen) {
  const lokal = String(adresse || "").split("@")[0].toLowerCase();
  if (!lokal) return "";
  const stuecke = lokal.split(/[._+-]+/).map((x) => x.replace(/\d+$/, "")).filter(Boolean);
  const woerter = new Set(stuecke);
  const ganz = stuecke.join("");
  for (const k of kollegen || []) {
    for (const teile of [normName(k), normName(umschrift(k))]) {
      if (teile.length < 2) continue;
      if (teile.every((t) => woerter.has(t))) return k;
      if (ganz === teile.join("") || ganz === [...teile].reverse().join("")) return k;
    }
  }
  return "";
}

const datumKurz = (iso) => (iso ? new Date(iso).toLocaleDateString("de-DE") : "");

/* Was wir über eine bekannte Domain wissen, in einem Satzteil:
   „in AP+ als Lieferant „Tunap AG“ aus der Schweiz (CH) · 77 Mails in
   den Akten". Mehrere Länder werden alle genannt – sie sind der
   Maßstab für die IBAN-Prüfung. */
export function bekanntText(info) {
  if (!info) return "";
  const teile = [];
  if (info.name) {
    const laender = (info.laender || []).map((k) => landName(isoAusKfz(k)) || k).filter(Boolean);
    teile.push(`bekannt als ${info.rolle ? info.rolle + " " : ""}„${info.name}“${laender.length ? ` aus ${laender.join(", ")}` : ""}`);
  }
  if (info.mails) teile.push(`von dir ${info.mails}× angeschrieben${info.zuletzt ? `, zuletzt am ${datumKurz(info.zuletzt)}` : ""}`);
  return teile.join(" · ");
}

/* Die Adresse des sendenden Rechners, die der Server nachschlägt – bei
   Mails aus dem Haus keine */
const gefragteIp = (ex, e) => (!/^internal$/i.test(ex.authAs) && e?.ip ? e.ip : "");

/* Welche DNS-Fragen der Server beantworten soll – oder null. Gefragt
   wird nur, wo es etwas zu prüfen gibt: SPF braucht die Adresse des
   sendenden Rechners, und die gibt es nur bei Mails von außen. */
export function dnsAnfrage(mail, eingang = EINGANG_HOSTS) {
  const e = eingangFinden(mail.kopf, eingang);
  const ex = exchangeAngaben(mail.kopf);
  const intern = /^internal$/i.test(ex.authAs);
  const von = mail.von?.domain || "";
  const mailfrom = (mail.returnPath.split("@")[1] || "").toLowerCase() || e?.helo || "";
  const weitere = [...new Set([mail.antwortAn?.domain].filter((d) => d && d !== von))];
  if (!von && !weitere.length) return null;
  /* Linkziele für die Sperrlisten (21.10.2026) – nur Domains, nie die Adresse */
  const { links } = linksAus(mail.html, mail.text || htmlZuText(mail.html));
  const linkDomains = [...new Set([...links, ...anhangLinks(mail)].map((l) => l.host).filter((h) => h && !/^[\d.:[\]]+$/.test(h)).map(basisDomain))]
    .filter((d) => d && !EIGENE_DOMAINS.some((x) => gleicheOrganisation(x, d))).slice(0, 10);
  return { ip: gefragteIp(ex, e), mailfrom: !intern ? mailfrom : "", von, helo: !intern ? e?.helo || "" : "", weitere, links: linkDomains };
}

/* Die Links aus den Anhängen (domain/anhangLinks.js, von der Oberfläche
   vorab in `mail.anhangLinks` gelegt) in der Form von linksAus, mit
   der Herkunft dazu. */
const HERKUNFT = { pdf: "Link in", qr: "QR-Code in" };
export function anhangLinks(mail) {
  return (mail.anhangLinks || []).map((a) => {
    const roh = /^www\./i.test(a.ziel) ? "http://" + a.ziel : a.ziel;
    const { ziel, verpackt } = linkEntpacken(roh);
    return { ziel, text: "", verpackt, host: hostAus(ziel), quelle: a.quelle, herkunft: `${HERKUNFT[a.quelle] || "aus"} „${a.anhang}“` };
  });
}

/* ------------------------------------------------------------------
   Was die Sperrlisten zu dieser Mail gesagt haben – AUCH wenn sie nichts
   gefunden haben (22.10.2026, Gregor Wolf: „woran sehe ich, ob Spamhaus
   funktioniert?"). Ein Treffer steht oben als Befund; ohne diese Angabe
   sahen „geprüft, sauber", „ohne Schlüssel" und „Listen nicht geladen"
   gleich aus – nach nichts. null ohne Server.

   `ip` ist die Adresse, die der Server bekommen hat (gefragteIp).
   ------------------------------------------------------------------ */
export function sperrlistenStand(dns, ip = "") {
  if (!dns) return null;
  const sh = dns.spamhaus;
  let spamhaus;
  if (!sh) spamhaus = { zustand: "aus" };
  else if (sh.fehler) spamhaus = { zustand: "fehler", fehler: sh.fehler };
  else {
    const domains = Object.keys(sh.domains || {});
    spamhaus = {
      zustand: "geprueft",
      domains,
      gelistet: domains.filter((d) => sh.domains[d] || sh.zrd?.[d]),
      /* null = ZEN nicht gefragt; [] = gefragt, nicht gelistet */
      rechner: sh.ipGeprueft || sh.ip?.length ? (sh.ip || []).map((z) => z.liste) : null,
    };
  }
  /* DROP/Feodo: "aus" (abgeschaltet), "nicht geladen", "" (nicht
     gelistet) oder der Name der Liste mit dem Treffer */
  const p = dns.sperre;
  const frei = !p ? "aus" : !p.geprueft ? "nicht geladen" : p.treffer ? p.treffer.liste : "";
  return { spamhaus, frei, ip };
}

/* Dasselbe als Zeilen für „Herkunft im Einzelnen" */
export function sperrlistenZeilen(s) {
  if (!s) return [];
  const z = [];
  const sh = s.spamhaus;
  if (sh.zustand === "aus") z.push("Spamhaus: nicht abgefragt – auf dem Server ist kein Schlüssel eingetragen");
  else if (sh.zustand === "fehler") z.push(`Spamhaus: Abfrage gescheitert (${sh.fehler}) – nicht geprüft`);
  else {
    const n = sh.domains.length;
    const wort = n === 1 ? "Domain" : "Domains";
    z.push(!n ? "Spamhaus DBL/ZRD: keine Domain zu prüfen (eigene und Freemail-Domains werden nicht gefragt)"
      : sh.gelistet.length ? `Spamhaus DBL/ZRD: ${sh.gelistet.length} von ${n} ${wort} gelistet – ${sh.gelistet.join(", ")}`
      : `Spamhaus DBL/ZRD: ${n} ${wort} geprüft, nicht gelistet – ${sh.domains.join(", ")}`);
  }
  if (!s.ip) {
    const listen = [sh.zustand === "geprueft" && "Spamhaus ZEN", s.frei !== "aus" && "DROP/Feodo"].filter(Boolean);
    if (listen.length) z.push(`${listen.join(", ")}: kein Rechner von außen zu prüfen`);
    return z;
  }
  if (sh.zustand === "geprueft") {
    z.push(sh.rechner === null ? `Spamhaus ZEN: ${s.ip} nicht abfragbar (nur IPv4)`
      : sh.rechner.length ? `Spamhaus ZEN: ${s.ip} gelistet – ${sh.rechner.join(", ")}`
      : `Spamhaus ZEN: ${s.ip} nicht gelistet`);
  }
  if (s.frei === "nicht geladen") z.push("DROP/Feodo: Listen nicht geladen – nicht geprüft");
  else if (s.frei !== "aus") z.push(s.frei ? `DROP/Feodo: ${s.ip} gelistet – ${s.frei}` : `DROP/Feodo: ${s.ip} nicht gelistet`);
  return z;
}

function spfBefund(spf, dmarc, mail, eingang, dazu) {
  const vonDomain = mail.von.domain;
  const ausgerichtet = gleicheOrganisation(spf.domain, vonDomain);
  const wo = eingang?.sicher ? "" : " (Übergabestelle nicht sicher bestimmt)";
  const ip = eingang?.ip || "?";
  const politik = dmarc?.p && dmarc.p !== "none" ? ` Die Domain verlangt für Fälschungen „${dmarc.p}“ (DMARC).` : "";
  const W = "Weg der Mail";
  if (spf.ergebnis === "pass") {
    if (ausgerichtet) dazu(W, "gruen", "Sendender Rechner ist zugelassen (SPF)", `${ip} darf für ${basisDomain(vonDomain)} senden${wo}.`);
    else dazu(W, "info", "SPF bestanden – für eine andere Domain", `Zugelassen für ${spf.domain}, nicht für ${vonDomain}. Bei Versanddiensten üblich; die Absenderdomain selbst ist damit nicht bestätigt.${politik}`);
  } else if (spf.ergebnis === "fail") {
    dazu(W, ausgerichtet ? "rot" : "gelb", "Sendender Rechner ist NICHT zugelassen (SPF)",
      `${spf.domain} erlaubt ${ip} nicht, in ihrem Namen zu senden${wo}. `
      + (ausgerichtet ? "Die Absenderadresse ist sehr wahrscheinlich gefälscht – es sei denn, die Mail wurde unterwegs weitergeleitet." : "")
      + politik);
  } else if (spf.ergebnis === "softfail") {
    dazu(W, "gelb", "Sendender Rechner ist nicht sicher zugelassen (SPF ~all)", `${spf.domain} kennt ${ip} nicht als eigenen Rechner, will das aber nicht hart ablehnen${wo}.${politik}`);
  } else if (spf.ergebnis === "none") {
    dazu(W, "info", "Domain ohne SPF-Regel", `${spf.domain || vonDomain} sagt nicht, welche Rechner für sie senden dürfen – der Absender lässt sich so nicht bestätigen.`);
  } else if (spf.ergebnis === "neutral") {
    dazu(W, "info", spf.grund ? "SPF nicht auswertbar" : "SPF ohne Aussage", spf.grund ? `${spf.domain}: ${spf.grund}.` : `${spf.domain} legt sich für ${ip} nicht fest.`);
  } else {
    dazu(W, "info", "SPF nicht prüfbar", `${spf.domain}: ${spf.grund || spf.ergebnis}.`);
  }
}

/* ------------------------------------------------------------------
   Der eine Aufruf.
   ------------------------------------------------------------------ */
export function mailPruefen(mail, umfeld = {}) {
  const { eigene = EIGENE_DOMAINS, eingang: eingangHosts = EINGANG_HOSTS, bekannte = null, mitApplus = false, kollegen = null, dns = null } = umfeld;
  const befunde = [];
  const dazu = (gruppe, stufe, titel, text, extra = {}) => befunde.push({ gruppe, stufe, titel, text, ...extra });
  const eigeneV = vorlagenAus(eigene);
  const bekannteV = bekannte ? vorlagenAus(bekannte.keys()) : [];
  const bekannteMenge = new Set(bekannte ? bekannte.keys() : []);

  /* ---------- Weg der Mail ---------- */
  const kopf = mail.kopf || [];
  const ex = exchangeAngaben(kopf);
  const eingang = eingangFinden(kopf, eingangHosts);
  const extern = ex.authAs ? !/^internal$/i.test(ex.authAs) : (eingang?.ip ? true : null);
  const sophos = sophosAngaben(kopf);
  const behauptung = absenderBehauptung(kopf);
  const W = "Weg der Mail";
  if (!kopf.length) {
    dazu(W, "info", "Keine Empfangsdaten", mail.quelle === "msg"
      ? "Diese Mail trägt keine Kopfzeilen vom Empfang – meist ist es eine gesendete Mail oder ein Entwurf. Woher sie kam, lässt sich nicht prüfen; Links, Anhänge und Text schon."
      : "Ohne Kopfzeilen lässt sich nicht prüfen, woher die Mail kam.");
  } else {
    if (extern === false) dazu(W, "gruen", "Im Haus verschickt", "Exchange hat die Mail von einem angemeldeten Absender im Haus angenommen.");
    if (sophos.doppelt) dazu(W, "gelb", "Sophos-Angabe doppelt", "Die Spam-Bewertung steht zweimal in der Mail – eine davon hat vermutlich der Absender mitgeschickt, um harmlos auszusehen.");
    if (sophos.wahrscheinlichkeit !== null) {
      const p = sophos.wahrscheinlichkeit;
      dazu(W, p >= 60 ? "rot" : p >= 30 ? "gelb" : "gruen", `Sophos: ${p} % Spam-Wahrscheinlichkeit`,
        p >= 30 ? "Der Spamfilter der Firewall hält die Mail für bedenklich." : "Unauffällig – echte Geschäftspost liegt meist zwischen 5 und 20 %.");
    }
    if (ex.scl !== null && ex.scl >= 5) dazu(W, "gelb", "Exchange stuft die Mail als Junk ein", `Spam-Stufe ${ex.scl} von 9.`);
    if (behauptung && [behauptung.spf, behauptung.dkim, behauptung.dmarc].includes("fail")) {
      dazu(W, "gelb", "Selbst das Absendersystem meldet ein Scheitern", `Angabe von ${behauptung.wer || "unterwegs"}: SPF ${behauptung.spf || "–"}, DKIM ${behauptung.dkim || "–"}, DMARC ${behauptung.dmarc || "–"}.`);
    }
    if (extern && dns?.spf) spfBefund(dns.spf, dns.dmarc, mail, eingang, dazu);
    else if (extern && eingang?.ip && !dns) {
      dazu(W, "info", "Absender nicht im Netz nachgeprüft", "Ob der sendende Rechner für die Domain zugelassen ist (SPF), prüft das Add-on über das Netz – ohne Verbindung fällt diese Prüfung weg.");
    }
    /* Sperrlisten für den sendenden Rechner (21.10.2026, domain/spamhaus.js) */
    const t = extern && dns?.sperre?.treffer;
    if (t) dazu(W, "rot", "Sendender Rechner steht auf einer Sperrliste", `${eingang?.ip || "Der Rechner"} steht auf ${t.liste}${t.kennung ? ` (${t.kennung})` : ""} – ein Netz von Betrügern oder ein gekaperter Rechner. Quelle: ${t.quelle}.`);
    for (const z of extern ? dns?.spamhaus?.ip || [] : []) {
      dazu(W, z.liste === "PBL" ? "gelb" : "rot", `Sendender Rechner bei Spamhaus gelistet (${z.liste})`,
        `${eingang?.ip || "Der Rechner"}: ${z.art}.${z.liste === "PBL" ? " Geschäftspost kommt sonst über einen Mailserver, nicht direkt von einem Anschluss." : ""}`);
    }
    if (dns?.spamhaus?.fehler) dazu(W, "info", "Spamhaus-Abfrage gescheitert", `${dns.spamhaus.fehler} – die Sperrlisten von Spamhaus sind für diese Mail nicht geprüft.`);
  }

  /* ---------- Absender ---------- */
  const A = "Absender";
  const von = mail.von || { name: "", adresse: "", domain: "" };
  const vonBasis = basisDomain(von.domain);
  const istEigene = eigene.some((d) => gleicheOrganisation(d, von.domain));
  const freemail = istFreemail(von.domain);
  const kollegeName = !istEigene && von.name ? kollegeImNamen(von.name, kollegen) : "";
  const kollegeAdresse = !istEigene && !kollegeName && von.adresse ? kollegeInAdresse(von.adresse, kollegen) : "";
  const kollege = kollegeName || kollegeAdresse;
  let unbekannt = false, aehnlich = false;
  if (!von.adresse) dazu(A, "gelb", "Kein Absender lesbar", "Die Mail nennt keine Absenderadresse.");
  if ((mail.vonAnzahl || 0) > 1) dazu(A, "rot", "Mehrere Absenderzeilen", "Die Mail hat mehr als eine From-Zeile – verschiedene Programme zeigen dann verschiedene Absender.");
  if (istEigene && extern === true) {
    const spfOk = dns?.spf?.ergebnis === "pass" && gleicheOrganisation(dns.spf.domain, von.domain);
    dazu(A, spfOk ? "gelb" : "rot", "Absender aus dem Haus – aber von außen gekommen",
      `Die Mail gibt sich als ${von.adresse} aus, kam aber nicht über unseren Exchange, sondern aus dem Internet.`
      + (spfOk ? " Der sendende Rechner ist zwar zugelassen (z. B. ein beauftragter Versanddienst) – trotzdem nachfragen." : " So sieht eine gefälschte Absenderadresse aus."));
  }
  const wieEigene = !istEigene && von.domain ? aehnlicheDomain(von.domain, eigeneV, { mitEnthalten: true }) : null;
  if (wieEigene) { aehnlich = true; dazu(A, "rot", "Absenderdomain ahmt eine eigene Domain nach", `${hostLesbar(von.domain)}: ${wieEigene.grund}.`); }
  if (bekannte && von.domain && !istEigene && !freemail) {
    const b = bekannte.get(vonBasis);
    const wo = "nicht unter den Adressen, die du angeschrieben hast";
    if (b) {
      dazu(A, "gruen", "Bekannter Absender", `${vonBasis} ist ${bekanntText(b)}.`);
    } else {
      unbekannt = true;
      const wie = wieEigene ? null : aehnlicheDomain(von.domain, bekannteV);
      if (wie) {
        aehnlich = wie.art !== "endung";
        const vorbild = bekanntText(bekannte.get(wie.aehnelt));
        dazu(A, wie.art === "endung" ? "gelb" : "rot", "Absenderdomain ähnelt einem bekannten Absender",
          `${hostLesbar(vonBasis)}: ${wie.grund}${vorbild ? ` (${vorbild})` : ""}. ${vonBasis} selbst steht ${wo}.`);
      } else {
        /* NICHT „erster Kontakt" ohne AP+: der Mailindex liest nur die
           Auftragsordner der Projekte im Planungstool (am 19.10.2026:
           97 Domains aus 3.612 Mails, die Ablage hat über 55.000). Mit
           dem AP+-Adressstamm (rund 2.700 Domains) ist „unbekannt"
           belastbarer – aber auch dort fehlt, wer nur angeschrieben hat. */
        dazu(A, "info", "Unbekannter Absender",
          `${vonBasis} steht ${wo} – neuer Kontakt?`);
      }
    }
  }
  if (freemail) dazu(A, "info", "Privatadresse", `${vonBasis} ist ein Freemail-Anbieter – für Geschäftspost ungewöhnlich, für Betrüger bequem.`);
  if (kollegeName) dazu(A, "rot", "Name eines Kollegen – Adresse von außen", `Angezeigt wird „${von.name}“, die Adresse ist ${von.adresse}. Mails von ${kollege} kommen von der eigenen Adresse${eigene[0] ? ` (@${eigene[0]})` : ""}.`);
  else if (kollegeAdresse) dazu(A, "rot", "Name eines Kollegen in fremder Adresse", `${von.adresse} trägt den Namen von ${kollege}, ist aber keine eigene Adresse${eigene[0] ? ` (@${eigene[0]})` : ""}.`);
  else if (!istEigene && /(?!)/.test(von.name)) dazu(A, "gelb", "Firmenname im Absender – Adresse von außen", `Angezeigt wird „${von.name}“, die Adresse ist ${von.adresse}.`);
  const imNamen = (von.name.match(/[^\s<>"'()]+@[^\s<>"'()]+/) || [])[0];
  if (imNamen && imNamen.toLowerCase() !== von.adresse.toLowerCase()) {
    dazu(A, "rot", "Anzeigename enthält eine andere Adresse", `Angezeigt wird „${von.name}“, tatsächlich sendet ${von.adresse}.`);
  }
  if (hatPunycode(von.domain)) dazu(A, "gelb", "Absenderdomain mit Sonderzeichen", `Die Domain heißt eigentlich ${von.domain} und sieht aus wie „${hostLesbar(von.domain)}“.`);
  const antwort = mail.antwortAn;
  const antwortAnders = !!(antwort?.domain && von.domain && !gleicheOrganisation(antwort.domain, von.domain));
  if (antwortAnders) {
    dazu(A, istEigene || kollege || istFreemail(antwort.domain) ? "rot" : "gelb", "Antworten gehen an eine andere Adresse",
      `Absender ${von.adresse}, eine Antwort ginge an ${antwort.adresse}.`);
  }
  for (const [rolle, d] of [["Absenderdomain", von.domain], ["Antwortdomain", antwort?.domain]]) {
    const info = d && dns?.domains?.[d];
    if (info && !info.gibtEs && !info.fehler) dazu(A, "rot", `${rolle} gibt es nicht`, `${d} hat weder Mailserver noch Adresse im DNS.`);
  }

  /* ---------- Alter der Domain (21.10.2026, domain/domainAlter.js) ----------
     Eine fünf Wochen alte Domain mit eigenem Postfach bei Google, SPF und
     DMARC in Ordnung: alles andere war grün. Das Alter steht nur da, wo der
     Server es nachgeschlagen hat; eigene und Freemail-Domains fragt er nicht. */
  const heute = umfeld.heute || new Date().toISOString().slice(0, 10);
  for (const [rolle, d] of [["Absenderdomain", istEigene ? "" : von.domain], ["Antwortdomain", antwortAnders ? antwort.domain : ""]]) {
    if (!d || istFreemail(d)) continue;
    const basis = basisDomain(d);
    const a = dns?.alter?.[basis];
    if (!a) continue;
    if (a.registriert) {
      const tage = tageSeit(a.registriert, heute);
      const bekannt = !!bekannte?.get(basis);
      const stufe = alterStufe(tage, bekannt);
      if (tage >= ALTER_GELB) {
        if (rolle === "Absenderdomain") dazu(A, "info", `${rolle} besteht ${alterText(tage, a.registriert)}`, `${basis} ist am ${datumKurz(a.registriert)} registriert worden.`);
      } else {
        dazu(A, stufe, `${rolle} ist neu – registriert ${alterText(tage, a.registriert)}`,
          `${basis} gibt es erst seit dem ${datumKurz(a.registriert)}. `
          + (bekannt
            ? "Der Absender ist bekannt – vielleicht hat die Firma umfirmiert. Im Zweifel unter der bekannten Nummer nachfragen."
            : "So arbeiten Betrüger, die es richtig machen: Domain kaufen, Postfach einrichten, schreiben – SPF und DMARC sind dann in Ordnung, nur das Alter verrät sie."));
      }
    } else if (a.ohneDatum && rolle === "Absenderdomain") {
      dazu(A, "info", "Alter der Domain nicht abrufbar", `Die Registrierungsstelle für .${basis.split(".").pop()} gibt das Registrierungsdatum nicht heraus.`);
    }
  }

  /* ---------- Sperrlisten und Endung (21.10.2026, domain/spamhaus.js) ---------- */
  const dblText = (b) => (b.missbraucht ? `eine eigentlich harmlose Domain, über die aber ${b.art} läuft` : b.art);
  for (const [rolle, d] of [["Absenderdomain", istEigene ? "" : von.domain], ["Antwortdomain", antwortAnders ? antwort.domain : ""]]) {
    if (!d || istFreemail(d)) continue;
    const basis = basisDomain(d);
    const dbl = dns?.spamhaus?.domains?.[basis];
    if (dbl) dazu(A, dbl.missbraucht ? "gelb" : "rot", `${rolle} steht bei Spamhaus auf der Sperrliste`, `${basis}: ${dblText(dbl)} (Spamhaus DBL).`);
    if (dns?.spamhaus?.zrd?.[basis]) dazu(A, "rot", `${rolle} ist erst seit Stunden im Netz`, `Spamhaus kennt ${basis} seit höchstens 24 Stunden (ZRD) – frisch angelegte Domains sind ein typisches Werkzeug für Betrug.`);
    const endung = !bekannte?.get(basis) ? missbrauchteEndung(basis) : "";
    if (endung && rolle === "Absenderdomain") dazu(A, "info", `Endung .${endung} wird oft missbraucht`, `Unter .${endung} sitzen überdurchschnittlich viele Spam- und Phishing-Domains. Das allein heißt nichts – zusammen mit anderem schon.`);
  }

  /* ---------- Links ---------- */
  const lesetext = mail.text || htmlZuText(mail.html);
  const { links, formulare } = linksAus(mail.html, lesetext);
  const linkUmfeld = { eigene: eigeneV, bekannte: bekannteV, bekannteMenge };
  const geprueft = [...links, ...anhangLinks(mail)].map((l) => {
    const bf = linkPruefen(l, linkUmfeld);
    return { ...l, befunde: bf, stufe: bf.reduce((s, b) => (RANG[b.stufe] > RANG[s] ? b.stufe : s), "gruen") };
  });
  const schonGemeldet = new Set();
  for (const l of geprueft) {
    for (const b of l.befunde) {
      const k = b.titel + "|" + basisDomain(l.host);
      if (schonGemeldet.has(k)) continue;
      schonGemeldet.add(k);
      dazu("Links", b.stufe, b.titel, b.text);
    }
  }
  if (formulare) dazu("Links", "rot", "Eingabeformular in der Mail", "Die Mail enthält ein Formular – Eingaben darin gehen direkt an den Absender.");
  /* Linkziele auf der Spamhaus-Sperrliste (21.10.2026) – die Absenderdomain ist oben schon gemeldet */
  for (const d of [...new Set(geprueft.map((l) => l.host && basisDomain(l.host)).filter(Boolean))]) {
    if (d === vonBasis) continue;
    const dbl = dns?.spamhaus?.domains?.[d];
    if (dbl) dazu("Links", dbl.missbraucht ? "gelb" : "rot", "Link führt zu einer Domain auf der Sperrliste", `${d}: ${dblText(dbl)} (Spamhaus DBL).`);
    else if (dns?.spamhaus?.zrd?.[d]) dazu("Links", "rot", "Link führt zu einer Domain, die erst seit Stunden existiert", `Spamhaus kennt ${d} seit höchstens 24 Stunden (ZRD).`);
  }
  const fremdeLinks = geprueft.filter((l) => l.host && !bekannteMenge.has(basisDomain(l.host))
    && !eigene.some((d) => gleicheOrganisation(d, l.host)) && !gleicheOrganisation(l.host, von.domain));
  /* Links aus Anhängen (28.10.2026, domain/anhangLinks.js). Ein QR-Code
     ist gelb, sobald er nicht zum Absender oder einem Bekannten führt:
     das Telefon öffnet ihn ohne Filter, und in Geschäftspost ist er
     selten. Ein PDF-Link nur zur Kenntnis – Rechnungen verlinken oft. */
  const fremd = new Set(fremdeLinks);
  for (const quelle of ["qr", "pdf"]) {
    const gemeldet = new Set();
    for (const l of geprueft.filter((x) => x.quelle === quelle && x.host)) {
      const d = basisDomain(l.host);
      if (gemeldet.has(d) || gemeldet.size >= 3) continue;
      gemeldet.add(d);
      const f = fremd.has(l);
      if (quelle === "qr") {
        dazu("Links", f ? "gelb" : "info", `QR-Code führt zu ${hostLesbar(l.host)}`,
          `${l.herkunft}: ein QR-Code mit dem Ziel ${hostLesbar(l.host)}. `
          + (f ? "QR-Codes umgehen Spamfilter und Linkprüfung – das Telefon öffnet die Seite ohne Schutz. Nicht scannen, solange der Absender nicht bestätigt ist." : "Das Ziel gehört zum Absender oder ist bekannt."));
      } else if (f) {
        dazu("Links", "info", `Link im PDF-Anhang auf ${hostLesbar(l.host)}`, `${l.herkunft}. Der Knopf in einer PDF ist ein Link wie jeder andere.`);
      }
    }
  }

  /* ---------- Anhänge ---------- */
  const treffer = inhaltPruefen(lesetext, mail.betreff);
  const hat = (k) => treffer.some((t) => t.schluessel === k);
  const anh = anhaengePruefen(mail.anhaenge, { kennwortImText: hat("kennwort") });
  for (const b of anh.befunde) dazu("Anhänge", b.stufe, b.titel, b.text);

  /* ---------- Inhalt und die Kombinationen ---------- */
  for (const t of treffer) dazu("Inhalt", t.stufe, t.titel, t.text, { fundstelle: t.fundstelle });
  const fremdAbsender = extern !== false && (unbekannt || freemail || antwortAnders || aehnlich || !!kollege);
  if (hat("bank") && fremdAbsender) {
    dazu("Inhalt", "rot", "Muster: Rechnungsbetrug", "Neue Bankverbindung von einem Absender, der nicht der gewohnte ist. Auf keinen Fall die Bankdaten ändern, bevor jemand unter einer bekannten Nummer angerufen hat.");
  }
  if (hat("zugang") && fremdeLinks.length) {
    dazu("Inhalt", "rot", "Muster: Zugangsdaten abgreifen", `Aufforderung zur Anmeldung und ein Link auf ${hostLesbar(fremdeLinks[0].host)}. Nicht klicken – den Dienst bei Bedarf über die eigene Lesezeichen-Adresse aufrufen.`);
  }
  if ((hat("chef") || hat("gutschein")) && (freemail || kollege || antwortAnders)) {
    dazu("Inhalt", "rot", "Muster: Chef-Betrug", "Eine kurze, dringliche Bitte unter einem bekannten Namen, aber von einer fremden Adresse. Den Kollegen auf einem anderen Weg fragen.");
  }

  /* ---------- Bankverbindung (domain/iban.js) ----------
     Gelesen wird nur, was der Absender selbst geschrieben hat – im Zitat
     darunter steht bei einer Antwort auf unsere Rechnung UNSERE IBAN.
     Verglichen wird mit dem Land aus AP+; kennt AP+ den Absender nicht,
     ersatzweise mit der Landesendung der Domain (`.de`, `.at` …).
     Freemail hat kein Land, `.me` ist eher Mode als Montenegro. */
  const ibans = ibansAus(`${mail.betreff}\n${eigenerTeil(lesetext)}`);
  const heimat = freemail ? [] : [...new Set((bekannte?.get(vonBasis)?.laender || []).map(isoAusKfz).filter(Boolean))];
  const tld = (von.domain.split(".").pop() || "").toUpperCase().replace(/^UK$/, "GB");
  const tldLand = !freemail && IBAN_LAENGE[tld] && tld !== "ME" ? tld : "";
  /* Abgleich mit der IBAN-Liste der Buchhaltung (28.10.2026): stehen für
     den Absender Bankverbindungen darin, muss die IBAN eine davon sein.
     Das ist der Fall, den der Ländervergleich nicht fängt – das fremde
     Konto im selben Land. */
  const hinterlegt = freemail ? [] : bekannte?.get(vonBasis)?.ibans || [];
  const besitzer = new Map();
  for (const [d, info] of bekannte || []) for (const h of info.ibans || []) if (!besitzer.has(h)) besitzer.set(h, d);
  const firma = (d) => bekannte?.get(d)?.name || d;
  for (const x of ibans) {
    if (!x.gueltig) {
      dazu("Inhalt", "gelb", "IBAN mit falscher Prüfziffer", `„${ibanLesbar(x.iban)}“ kann so nicht stimmen – vertippt oder erfunden.`);
      continue;
    }
    const summe = ibanPruefsumme(x.iban);
    if (hinterlegt.includes(summe)) {
      dazu("Inhalt", "gruen", "Bekannte Bankverbindung", `${ibanLesbar(x.iban)} ist bei der Buchhaltung für ${firma(vonBasis)} hinterlegt.`);
      continue;
    }
    const anderer = besitzer.get(summe);
    if (hinterlegt.length) {
      dazu("Inhalt", hat("bank") ? "rot" : "gelb", `Bankverbindung ist für ${firma(vonBasis)} nicht hinterlegt`,
        `Die Buchhaltung kennt für ${firma(vonBasis)} ${hinterlegt.length === 1 ? "eine Bankverbindung" : `${hinterlegt.length} Bankverbindungen`} – ${ibanLesbar(x.iban)} gehört nicht dazu`
        + (anderer ? ` (sie ist für ${firma(anderer)} hinterlegt)` : "")
        + ". Vor jeder Zahlung oder Änderung der Stammdaten unter der bekannten Nummer anrufen.");
      continue;
    }
    if (anderer && anderer !== vonBasis) {
      dazu("Inhalt", "info", "IBAN eines anderen Geschäftspartners", `${ibanLesbar(x.iban)} ist bei der Buchhaltung für ${firma(anderer)} hinterlegt, nicht für ${vonBasis || "den Absender"}.`);
    }
    const vergleich = heimat.length ? heimat : tldLand ? [tldLand] : [];
    if (!vergleich.length || vergleich.includes(x.land)) continue;
    const woher = heimat.length
      ? `${vonBasis} ist in AP+ in ${heimat.map(landName).join(", ")} hinterlegt`
      : `die Domain ${vonBasis} endet auf .${tld.toLowerCase()}`;
    if (hat("bank")) {
      dazu("Inhalt", "rot", "Neue Bankverbindung in einem anderen Land",
        `Die IBAN ${ibanLesbar(x.iban)} ist aus ${landName(x.land)}, ${woher}. So sieht Betrug über ein übernommenes Postfach aus: der Absender ist echt, das Konto nicht. Vor jeder Zahlung unter der bekannten Nummer anrufen.`);
    } else {
      dazu("Inhalt", "gelb", "IBAN aus einem anderen Land", `Die IBAN ${ibanLesbar(x.iban)} ist aus ${landName(x.land)}, ${woher}.`);
    }
  }

  /* ---------- Urteil ---------- */
  const stufe = befunde.some((b) => b.stufe === "rot") ? "rot" : befunde.some((b) => b.stufe === "gelb") ? "gelb" : "gruen";
  befunde.sort((a, b) => GRUPPEN.indexOf(a.gruppe) - GRUPPEN.indexOf(b.gruppe) || RANG[b.stufe] - RANG[a.stufe]);
  return {
    stufe,
    urteil: URTEIL[stufe],
    befunde,
    links: geprueft,
    anhaenge: anh.liste,
    lesetext,
    fakten: { extern, eingang, exchange: ex, sophos, behauptung, spf: dns?.spf || null, dmarc: dns?.dmarc || null, ibans, sperrlisten: sperrlistenStand(dns, gefragteIp(ex, eingang)) },
    umfeld: { archiv: !!bekannte, applus: !!(bekannte && mitApplus), kollegen: !!kollegen, dns: !!dns, ibans: besitzer.size > 0 },
  };
}

export const URTEIL = {
  rot: { titel: "Gefährlich", text: "Diese Mail trägt deutliche Zeichen einer Fälschung. Keine Links anklicken, keine Anhänge öffnen, nicht antworten. Im Zweifel den Absender unter einer bekannten Telefonnummer fragen – nicht über die Angaben in der Mail." },
  gelb: { titel: "Verdächtig", text: "Einiges ist auffällig. Genau hinsehen, bevor etwas angeklickt, geöffnet oder bezahlt wird – und im Zweifel nachfragen." },
  gruen: { titel: "Keine Auffälligkeiten", text: "Die Prüfung hat nichts gefunden. Das ist keine Garantie: wer das echte Postfach eines Geschäftspartners übernommen hat, schreibt von dessen echter Adresse." },
};
