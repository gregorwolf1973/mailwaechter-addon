/* kopiert aus planungstool (src/domain/mailDomain.js), nicht hier ändern – scripts/regeln-holen.mjs, mit kleinen Ersetzungen für Gmail */
/* ============================================================
   Domains einer Mail beurteilen – Grundbausteine der Mailprüfung
   (werkzeuge/mailpruefung, 19.10.2026)

   Gregor Wolf: „kann der server eingehende mails … untersuchen ob das
   spam/fake ist?" – gebaut als Prüfen auf Zuruf: eine Mail wird
   hineingezogen, nichts wird mitgeschnitten (docs/mail-anbindung.md:
   „kein Mitschnitt von Postfächern").

   Hier steht, was man über einen DOMAINNAMEN sagen kann, ohne ihn
   nachzuschlagen: zu welcher Organisation er gehört, ob er einer
   bekannten Domain zum Verwechseln ähnlich sieht, ob er ein
   Freemail-Anbieter ist.

   DIE BETRUGSMASCHE, UM DIE ES VOR ALLEM GEHT: eine Rechnung von
   `europak.gr` statt `europack.gr`, mit „neuer Bankverbindung". Die
   Ähnlichkeitsprüfung ist deshalb der Kern dieser Datei – und sie ist
   bewusst vorsichtig: zwei verschiedene echte Firmen mit ähnlichem
   Namen dürfen sich nicht gegenseitig als Fälschung melden. Wer eine
   Domain selbst schon im Archiv hat, ist nie „ähnlich", sondern
   bekannt.

   REIN UND TESTBAR: Text hinein, Ergebnis heraus. Kein DOM, kein Netz.
   ============================================================ */

/* Die eigenen Domains. Mails, die so aussehen, als kämen sie von hier,
   aber von außen kommen, sind die gefährlichste Klasse überhaupt. */
export const EIGENE_DOMAINS = [];

/* Endungen, unter denen erst die DRITTE Stufe die Organisation nennt
   (`firma.co.uk`, nicht `co.uk`). Keine vollständige Public-Suffix-
   Liste – die hat zehntausend Einträge. Diese hier decken ab, was in
   der Korrespondenz eines Maschinenbauers vorkommt; eine fehlende
   Endung macht die Organisation nur eine Stufe zu grob. */
const ZWEITSTUFIG = new Set((
  "co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk com.au net.au org.au edu.au gov.au co.nz "
  + "co.jp ne.jp or.jp co.kr com.cn net.cn org.cn com.tw com.hk com.sg com.my co.in net.in "
  + "org.in co.za com.br com.mx com.ar com.tr co.at or.at gv.at ac.at co.il com.pl net.pl "
  + "com.ua co.id com.vn com.ph com.eg com.sa co.th co.hu com.ru com.es com.pt com.co"
).split(" "));

const kleinHost = (h) => String(h || "").trim().toLowerCase().replace(/\.$/, "");

export const domainVon = (adresse) => {
  const s = String(adresse || "");
  const i = s.lastIndexOf("@");
  return i >= 0 ? kleinHost(s.slice(i + 1).replace(/[>\s].*$/, "")) : "";
};

/* Die Organisation hinter einem Rechnernamen: `mail.kunde.de` → `kunde.de`. */
export function basisDomain(host) {
  const teile = kleinHost(host).split(".").filter(Boolean);
  if (teile.length <= 2) return teile.join(".");
  const zwei = teile.slice(-2).join(".");
  return ZWEITSTUFIG.has(zwei) ? teile.slice(-3).join(".") : zwei;
}

/* Der Name ohne Endung: `europack.gr` → `europack`. */
export function domainName(host) {
  const basis = basisDomain(host);
  const teile = basis.split(".");
  return teile.length > 1 ? teile.slice(0, ZWEITSTUFIG.has(teile.slice(-2).join(".")) ? -2 : -1).join(".") : basis;
}

export const gleicheOrganisation = (a, b) => !!a && !!b && basisDomain(a) === basisDomain(b);

/* ------------------------------------------------------------------
   Punycode (RFC 3492) – `xn--pple-43d.com` ist „аpple.com" mit
   kyrillischem а. Outlook zeigt je nach Einstellung das eine oder das
   andere; geprüft werden muss, was der MENSCH sieht.
   Jede Schleife hat eine Obergrenze (Regel aus msgLesen.js).
   ------------------------------------------------------------------ */
function punyZiffer(c) {
  if (c >= 48 && c <= 57) return c - 22;
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 97;
  return 36;
}

export function punycodeDekodieren(label) {
  const s = String(label || "");
  if (s.length > 63) return null;
  let n = 128, i = 0, bias = 72;
  const raus = [];
  const trenn = s.lastIndexOf("-");
  for (let j = 0; j < Math.max(0, trenn); j++) raus.push(s.charCodeAt(j));
  const anpassen = (delta, anzahl, erstes) => {
    delta = erstes ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / anzahl);
    let k = 0;
    for (let runde = 0; delta > 455 && runde < 20; runde++) { delta = Math.floor(delta / 35); k += 36; }
    return k + Math.floor((36 * delta) / (delta + 38));
  };
  for (let p = trenn > 0 ? trenn + 1 : 0, runden = 0; p < s.length && runden < 64; runden++) {
    const alt = i;
    for (let w = 1, k = 36; ; k += 36) {
      if (p >= s.length || k > 36 * 64) return null;
      const ziffer = punyZiffer(s.charCodeAt(p++));
      if (ziffer >= 36) return null;
      i += ziffer * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (ziffer < t) break;
      w *= 36 - t;
    }
    bias = anpassen(i - alt, raus.length + 1, alt === 0);
    n += Math.floor(i / (raus.length + 1));
    i %= raus.length + 1;
    if (n > 0x10FFFF) return null;
    raus.splice(i++, 0, n);
  }
  try { return String.fromCodePoint(...raus); } catch { return null; }
}

/* Ein Rechnername so, wie ihn der Mensch liest. */
export const hostLesbar = (host) => kleinHost(host).split(".")
  .map((l) => (l.startsWith("xn--") ? punycodeDekodieren(l.slice(4)) || l : l)).join(".");

export const hatPunycode = (host) => kleinHost(host).split(".").some((l) => l.startsWith("xn--"));

/* ------------------------------------------------------------------
   Das „Skelett" eines Namens: alles, was gleich AUSSIEHT, wird gleich.
   Kyrillisches а wie lateinisches a, 0 wie o, 1 wie l, „rn" wie m.
   Akzente fallen weg. Auch der Bindestrich: `oligmbh.de` und
   `oli-gmbh.de` sind für den Leser dieselbe Firma.
   ------------------------------------------------------------------ */
const GLEICH_AUSSEHEND = {
  "а": "a", "е": "e", "ё": "e", "і": "i", "ї": "i", "ј": "j", "к": "k", "м": "m", "о": "o",
  "р": "p", "с": "c", "у": "y", "х": "x", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h",
  "ӏ": "l", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t",
  "υ": "u", "χ": "x", "ω": "w", "0": "o", "1": "l", "ı": "i",
};

export function skelett(name) {
  let s = hostLesbar(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = [...s].map((c) => GLEICH_AUSSEHEND[c] || c).join("");
  /* `i` und `l` erst NACH der Tabelle angleichen: aus „1" wird „l",
     und ein großes I sieht in vielen Schriften aus wie ein kleines l. */
  return s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d").replace(/i/g, "l").replace(/[-_.]/g, "");
}

/* Tippabstand (Levenshtein) mit Deckel: über `max` hinaus ist die Zahl
   egal, und so bleibt der Vergleich gegen tausend Domains billig. */
export function abstand(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let vorher = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const jetzt = [i];
    let kleinste = i;
    for (let j = 1; j <= b.length; j++) {
      jetzt[j] = Math.min(vorher[j] + 1, jetzt[j - 1] + 1, vorher[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      kleinste = Math.min(kleinste, jetzt[j]);
    }
    if (kleinste > max) return max + 1;
    vorher = jetzt;
  }
  return vorher[b.length];
}

/* ------------------------------------------------------------------
   Sieht `host` einer der `vorlagen` zum Verwechseln ähnlich?

   Rückgabe: null, oder { aehnelt, grund, art } – `art` ist
   "zeichen" (vertauschte/ersetzte Zeichen, die Fälschung schlechthin),
   "endung" (gleicher Name, andere Endung – bei großen Firmen auch
   harmlos) oder "enthalten" (der Name steckt in einer fremden Domain,
   nur bei `mitEnthalten`, also bei den eigenen Domains).

   DIE GRENZEN SIND MIT ABSICHT ENG. Ein Zeichen Abstand erst ab fünf
   Buchstaben, zwei erst ab neun: „kuka.de" und „kuk.de" sind zwei
   Firmen, „europack" und „europak" ist eine Masche.
   ------------------------------------------------------------------ */
/* Die Vorlagen EINMAL aufbereiten: gegen fünftausend bekannte Domains
   wird je Mail ein Dutzend Mal verglichen (Absender, Antwortadresse,
   jeder Link), und das Skelett jedes Mal neu zu rechnen kostet mehr als
   der Vergleich selbst. */
export const vorlagenAus = (domains) => [...domains].map((d) => {
  const v = basisDomain(d);
  const vName = domainName(v);
  return { v, vName, vSk: skelett(vName) };
}).filter((x) => x.v);

export function aehnlicheDomain(host, vorlagen, { mitEnthalten = false } = {}) {
  const basis = basisDomain(hostLesbar(host));
  if (!basis) return null;
  const liste = [...vorlagen].map((x) => (typeof x === "string" ? vorlagenAus([x])[0] : x)).filter(Boolean);
  if (liste.some((x) => x.v === basis)) return null;
  const name = domainName(basis), sk = skelett(name);
  const ganz = skelett(hostLesbar(host));
  for (const { v, vName, vSk } of liste) {
    if (vSk.length < 4) continue;
    if (sk === vSk) {
      return name === vName
        ? { aehnelt: v, art: "endung", grund: `gleicher Name wie ${v}, aber andere Endung` }
        : { aehnelt: v, art: "zeichen", grund: `zum Verwechseln ähnlich geschrieben wie ${v}` };
    }
    const d = abstand(sk, vSk, 2);
    if ((d === 1 && vSk.length >= 5) || (d === 2 && vSk.length >= 9)) {
      return { aehnelt: v, art: "zeichen", grund: `${d === 1 ? "ein Zeichen" : "zwei Zeichen"} anders als ${v}` };
    }
    if (mitEnthalten && vSk.length >= 5 && ganz.includes(vSk)) {
      return { aehnelt: v, art: "enthalten", grund: `enthält den Namen „${vName}“, ist aber eine fremde Domain` };
    }
  }
  return null;
}

/* ------------------------------------------------------------------
   Listen. Kurz gehalten und nur, wo sie etwas entscheiden.
   ------------------------------------------------------------------ */
export const FREEMAIL = new Set((
  "gmail.com googlemail.com gmx.de gmx.net gmx.at gmx.ch web.de t-online.de outlook.com outlook.de "
  + "hotmail.com hotmail.de live.com live.de msn.com yahoo.com yahoo.de icloud.com me.com aol.com "
  + "freenet.de mail.de posteo.de protonmail.com proton.me mail.ru yandex.ru yandex.com qq.com "
  + "163.com arcor.de online.de email.de gmx.com zoho.com"
).split(" "));
export const istFreemail = (host) => FREEMAIL.has(basisDomain(host));

/* Kurzlinks: das Ziel ist verborgen, bis man klickt. */
export const KURZLINKS = new Set(("bit.ly tinyurl.com t.ly is.gd ow.ly buff.ly rebrand.ly cutt.ly "
  + "shorturl.at rb.gy tiny.cc s.id v.gd qrco.de").split(" "));

/* Dienste, auf denen jeder in Minuten eine Seite ins Netz stellt – die
   Anmeldeseiten der Phishing-Mails liegen fast immer auf so etwas. Ein
   Treffer ist ein Hinweis, kein Urteil: auch Echtes liegt dort. */
const FREIE_SEITEN = ("web.app firebaseapp.com pages.dev workers.dev netlify.app vercel.app github.io "
  + "glitch.me ngrok.io ngrok-free.app herokuapp.com blogspot.com wixsite.com weebly.com square.site "
  + "r2.dev azurewebsites.net webflow.io framer.app notion.site carrd.co godaddysites.com "
  + "000webhostapp.com repl.co surge.sh onrender.com").split(" ");
export const istFreieSeite = (host) => {
  const h = kleinHost(host);
  return FREIE_SEITEN.some((d) => h === d || h.endsWith("." + d))
    || /^(sites|forms)\.google\.com$|^storage\.googleapis\.com$|\.blob\.core\.windows\.net$|\.ipfs\./.test(h);
};

/* Zähldienste von Newslettern: dort zeigt ein Link „www.firma.de" an
   und führt doch über einen fremden Rechner. Das ist üblich und kein
   Betrug – es macht einen abweichenden Link nur weniger auffällig. */
const ZAEHLDIENSTE = ("list-manage.com sendgrid.net mandrillapp.com hubspotlinks.com hs-sites.com "
  + "mailjet.com sendibt3.com sendibt2.com brevo.com exacttarget.com cleverreach.com rapidmail.de "
  + "newsletter2go.com mailerlite.com constantcontact.com klaviyo.com mailchimp.com mlsend.com "
  + "salesforce.com mktotracking.com mkt.com evalanche.com inxmail.com").split(" ");
export const istZaehldienst = (host) => {
  const b = basisDomain(host);
  return ZAEHLDIENSTE.includes(b) || /^(click|links?|track|t|email|mail|news|e)\./.test(kleinHost(host));
};

export const istIpAdresse = (host) => {
  const h = kleinHost(host);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^\[?[0-9a-f:.]+\]?$/.test(h));
};

/* Endungen, die überdurchschnittlich oft für Spam und Phishing genutzt
   werden (21.10.2026) – nach den Ranglisten von Spamhaus („Most abused
   TLDs") und den Phishing-Berichten von Interisle; Stand Herbst 2026.
   Viele echte Firmen nutzen sie auch, deshalb nur ein Hinweis und nur
   bei Absendern, die wir nicht kennen. Ländercodes stehen bewusst nicht
   darin – Kunden in aller Welt schreiben von .cn, .ru, .in. */
export const MISSBRAUCHTE_ENDUNGEN = new Set(("top xyz click icu cfd sbs cyou buzz rest bond monster quest lol "
  + "beauty hair makeup skin mom boats autos yachts zip mov work gq ml cf ga tk support live online site "
  + "shop store fun space website club vip win bid loan").split(" "));
export const missbrauchteEndung = (host) => {
  const e = kleinHost(host).split(".").pop() || "";
  return MISSBRAUCHTE_ENDUNGEN.has(e) ? e : "";
};
