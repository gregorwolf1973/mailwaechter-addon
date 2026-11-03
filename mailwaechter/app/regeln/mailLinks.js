/* kopiert aus planungstool (src/domain/mailLinks.js), nicht hier ändern – scripts/regeln-holen.mjs, mit kleinen Ersetzungen für Gmail */
import {
  basisDomain, hostLesbar, hatPunycode, aehnlicheDomain, istIpAdresse, KURZLINKS, istFreieSeite, istZaehldienst,
} from "./mailDomain.js";

/* ============================================================
   Die Links einer Mail – herausholen und beurteilen (19.10.2026)

   Phishing lebt vom Link: der Text sagt „sparkasse.de", der Link führt
   woanders hin. Gelesen wird deshalb beides – das ZIEL (`href`) und
   der TEXT, den der Mensch sieht.

   REIN, KEIN DOM: das HTML wird mit regulären Ausdrücken gelesen, wie in
   domain/mailHtml.js. Hier wird nichts angezeigt, nur gezählt und
   verglichen – ein übersehener Link ist ein fehlender Hinweis, keine
   Lücke in der Anzeige.
   ============================================================ */

const ENTITAETEN = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const entitaetenLoesen = (s) => String(s || "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ""; } })
  .replace(/&(\w+);/g, (m, n) => ENTITAETEN[n.toLowerCase()] ?? m);

/* Sichtbarer Text aus HTML – für Linktexte und für Mails, deren Text
   nur als HTML vorliegt. Zeilenenden bleiben, wo Absätze waren. */
export const htmlZuText = (s) => entitaetenLoesen(String(s || "")
  .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
  .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
  .replace(/<[^>]*>/g, " "))
  .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();

/* Ein Link, den ein Schutzdienst eingewickelt hat, wird ausgepackt:
   beurteilt wird das Ziel, nicht der Umweg. */
export function linkEntpacken(adresse) {
  const s = String(adresse || "").trim();
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (/\.safelinks\.protection\.outlook\.com$/.test(h) && u.searchParams.get("url")) {
      return { ziel: u.searchParams.get("url"), verpackt: "Microsoft Safe Links" };
    }
    if ((h === "www.google.com" || h === "google.com") && u.pathname === "/url" && u.searchParams.get("q")) {
      return { ziel: u.searchParams.get("q"), verpackt: "Google-Weiterleitung" };
    }
  } catch { /* kein gültiger Link – bleibt, wie er ist */ }
  return { ziel: s, verpackt: "" };
}

export function hostAus(adresse) {
  try { return new URL(adresse).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return ""; }
}

/* ------------------------------------------------------------------
   Alle Links: aus dem HTML (`<a href>`, `<area href>`) mit ihrem Text,
   dazu nackte Adressen aus dem Klartext. Doppelte fallen zusammen.
   `formulare` zählt `<form>` – ein Eingabeformular gehört nicht in
   eine Mail.
   ------------------------------------------------------------------ */
export function linksAus(html, text) {
  const raus = [];
  const gesehen = new Set();
  const dazu = (rohZiel, anzeige) => {
    const roh = entitaetenLoesen(rohZiel).trim();
    if (!roh || /^(#|cid:|mailto:|tel:)/i.test(roh)) return;
    const { ziel, verpackt } = linkEntpacken(roh);
    const schluessel = ziel + "\n" + anzeige;
    if (gesehen.has(schluessel) || raus.length >= 300) return;
    gesehen.add(schluessel);
    raus.push({ ziel, text: anzeige, verpackt, host: hostAus(ziel) });
  };
  const h = String(html || "");
  const anker = /<(a|area)\b([^>]*)>([\s\S]*?)(?:<\/\1\s*>|$)/gi;
  for (let m, n = 0; (m = anker.exec(h)) && n < 2000; n++) {
    const href = m[2].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (href) dazu(href[1] ?? href[2] ?? href[3] ?? "", m[1].toLowerCase() === "a" ? htmlZuText(m[3]).replace(/\s+/g, " ").slice(0, 200) : "");
  }
  /* Der sichtbare TEXT eines Links steht auch im Klartext. „www.tunap.com"
     als Beschriftung eines Links nach `pages.dev` ist kein zweiter Link
     – als solcher gezählt, sähe es aus, als gäbe es auch den echten. */
  const beschriftungen = new Set(raus.map((l) => l.text.toLowerCase()).filter(Boolean));
  const nackt = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]]+/gi;
  for (const m of String(text || "").matchAll(nackt)) {
    const adresse = m[0].replace(/[.,;:!?]+$/, "");
    if (beschriftungen.has(adresse.toLowerCase())) continue;
    const ziel = /^www\./i.test(adresse) ? "http://" + adresse : adresse;
    if (![...gesehen].some((g) => g.startsWith(linkEntpacken(ziel).ziel + "\n"))) dazu(ziel, "");
  }
  const formulare = (h.match(/<form\b/gi) || []).length;
  return { links: raus, formulare };
}

/* Steht im Linktext selbst eine Adresse oder Domain? Dann muss sie zum
   Ziel passen. „Hier klicken" ist kein Widerspruch, „www.sparkasse.de"
   mit Ziel `login-sicher.xyz` ist einer. */
/* OHNE „http"/„www." VORNEWEG zählt nur eine gängige Endung: sonst
   wäre „Zeichnung.pdf" eine Domain namens zeichnung.pdf und „Hr.Meier"
   eine unter .meier. */
const GAENGIGE_ENDUNG = new Set(("de com net org eu at ch info biz io co uk fr it es nl be pl cz gr us "
  + "app dev xyz online shop site top ru cn tk ml ga cf gq li lu dk se no fi pt hu ro sk si hr tr").split(" "));

export function domainImText(text) {
  const t = String(text || "");
  if (/@/.test(t)) return "";
  const m = t.match(/(https?:\/\/|www\.)?((?:[a-z0-9-]+\.)+([a-z]{2,24}))(?=[/\s:?#]|$)/i);
  if (!m) return "";
  return (m[1] || GAENGIGE_ENDUNG.has(m[3].toLowerCase())) ? m[2].toLowerCase() : "";
}

/* ------------------------------------------------------------------
   Einen Link beurteilen. Rückgabe: Liste von { stufe, titel, text }.

   `eigene` und `bekannte` sind aufbereitete Vorlagen (vorlagenAus) –
   eigene Domains und die Domains aus dem Mailarchiv. `bekannteMenge`
   enthält die Basisdomains, die im Archiv vorkommen.
   ------------------------------------------------------------------ */
export function linkPruefen(link, { eigene = [], bekannte = [], bekannteMenge = new Set() } = {}) {
  const befunde = [];
  const s = (stufe, titel, text) => befunde.push({ stufe, titel, text });
  const ziel = String(link.ziel || "");
  if (/^\s*(javascript|vbscript|data|file):/i.test(ziel)) {
    s("rot", "Link führt Code aus", `Das Ziel beginnt mit „${ziel.split(":")[0]}:“ – so etwas hat in einer Mail nichts zu suchen.`);
    return befunde;
  }
  const host = link.host || hostAus(ziel);
  if (!host) return befunde;
  const lesbar = hostLesbar(host);
  let u = null;
  try { u = new URL(ziel); } catch { /* bleibt null */ }
  if (u && (u.username || u.password)) {
    s("rot", "Link mit @-Tarnung", `Vor dem @ steht „${decodeURIComponent(u.username)}“ – das ist Tarnung, das Ziel ist ${lesbar}.`);
  }
  if (istIpAdresse(host)) s("gelb", "Link auf eine nackte IP-Adresse", `Ziel ${host} – seriöse Firmen verlinken auf ihren Namen.`);
  if (hatPunycode(host)) s("gelb", "Link mit Sonderzeichen-Domain", `Das Ziel heißt eigentlich ${host} und sieht aus wie „${lesbar}“.`);

  const imText = domainImText(link.text);
  if (imText && basisDomain(imText) !== basisDomain(lesbar)) {
    const zaehl = istZaehldienst(host);
    s(zaehl ? "gelb" : "rot", "Link zeigt etwas anderes an, als er öffnet",
      `Angezeigt wird ${imText}, geöffnet wird ${lesbar}.`
      + (zaehl ? " Newsletter leiten oft über einen Zähldienst um – trotzdem nicht blind folgen." : ""));
  }
  const wieEigene = aehnlicheDomain(lesbar, eigene, { mitEnthalten: true });
  if (wieEigene) s("rot", "Link auf eine nachgemachte eigene Domain", `${lesbar}: ${wieEigene.grund}.`);
  else if (!bekannteMenge.has(basisDomain(lesbar))) {
    const wie = aehnlicheDomain(lesbar, bekannte);
    if (wie) s(wie.art === "endung" ? "gelb" : "rot", "Link auf eine Domain, die einer bekannten ähnelt", `${lesbar}: ${wie.grund}.`);
  }
  if (KURZLINKS.has(basisDomain(host)) || KURZLINKS.has(host)) s("gelb", "Kurzlink", `${host} verbirgt das eigentliche Ziel, bis man klickt.`);
  if (istFreieSeite(host)) s("gelb", "Link auf einen freien Seitendienst", `${lesbar} – dort kann jeder in Minuten eine Seite ablegen, auch eine nachgemachte Anmeldeseite.`);
  return befunde;
}
