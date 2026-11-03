/* Oberfläche des Mailwächters – nur relative Adressen (Ingress). */
const $ = (id) => document.getElementById(id);
let filter = "alle";
let testLief = false;

const el = (tag, klasse, text) => {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
};
const zeit = (iso) => (iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–");

async function api(pfad, optionen) {
  const r = await fetch(pfad, optionen);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.fehler || "Fehler " + r.status);
  return j;
}

function meldung(text) {
  const m = $("meldung");
  m.hidden = !text;
  m.textContent = text || "";
}

async function statusLaden() {
  try {
    const s = await api("api/status");
    const z = $("status");
    z.textContent = "";
    if (!s.konfiguriert) {
      z.append(el("b", "nein", "Nicht eingerichtet"), " – Gmail-Adresse und App-Passwort in den Add-on-Optionen eintragen.");
    } else {
      z.append(el("b", s.verbunden ? "ok" : "nein", s.verbunden ? "Verbunden" : "Getrennt"),
        ` mit ${s.gmail}` + (s.verbunden ? ` seit ${zeit(s.seit)}` : s.fehler ? ` (${s.fehler}${s.naechsterVersuch ? ", nächster Versuch " + zeit(s.naechsterVersuch) : ""})` : ""),
        ` · ${s.geprueft} Mails geprüft`, ` · ${s.bekannteDomains} bekannte Domains (Stand ${zeit(s.gesendetStand)})`,
        s.nurMelden ? " · Modus: nur melden" : "");
    }
    $("test").disabled = !s.konfiguriert || !s.verbunden || s.test.laeuft;
    if (s.test.laeuft) { testLief = true; meldung("Testlauf läuft …"); }
    else if (testLief) {
      testLief = false;
      meldung(s.test.fehler ? "Testlauf gescheitert: " + s.test.fehler : `Testlauf fertig: ${s.test.ergebnis ?? 0} Mails geprüft (nichts verschoben).`);
      listeLaden();
    }
  } catch (e) { $("status").textContent = "Keine Verbindung zum Add-on: " + e.message; }
}

const AMPEL = { rot: "Rot", gelb: "Gelb", gruen: "Grün", info: "Info", fehler: "Fehler" };

function eintragZeichnen(e) {
  const karte = el("article", "eintrag " + (e.stufe === "fehler" || e.stufe === "info" ? "" : e.stufe));
  const kopf = el("div", "kopf");
  kopf.append(el("span", "ampel", AMPEL[e.stufe] || e.stufe), el("span", "betreff", e.betreff || "(kein Betreff)"));
  karte.append(kopf, el("div", "von", e.von));
  const meta = `${zeit(e.zeit)} · ${e.aktion}${e.test ? " (Testlauf)" : ""}${e.zurueckgeholt ? " · zurückgeholt" : ""}`;
  karte.append(el("div", "meta", meta));
  const gruende = (e.gruende || []).filter((g) => g.stufe !== "info" || e.stufe === "fehler");
  if (gruende.length) {
    const ul = el("ul", "gruende");
    for (const g of gruende) {
      const li = el("li", g.stufe);
      li.append(el("b", "", g.titel));
      if (g.text) li.append(" – ", el("span", "", g.text));
      ul.append(li);
    }
    karte.append(ul);
  }
  if ((e.stufe === "rot" || e.stufe === "gelb") && !e.zurueckgeholt) {
    const a = el("div", "aktionen");
    const knopf = el("button", "", "Zurückholen");
    knopf.title = "Mail zurück in den Posteingang, Labels entfernen, Absenderdomain künftig als bekannt merken";
    knopf.onclick = async () => {
      knopf.disabled = true;
      try {
        const r = await api("api/zurueckholen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id }) });
        meldung("Zurückgeholt." + (r.domainGemerkt ? ` ${r.domainGemerkt} gilt künftig als bekannt.` : ""));
        listeLaden();
      } catch (err) { meldung("Zurückholen gescheitert: " + err.message); knopf.disabled = false; }
    };
    a.append(knopf);
    karte.append(a);
  }
  return karte;
}

async function listeLaden() {
  const liste = $("liste");
  try {
    const { eintraege } = await api("api/eintraege?filter=" + filter);
    liste.textContent = "";
    if (!eintraege.length) liste.append(el("p", "leer", "Noch nichts geprüft – neue Mails erscheinen hier, sobald sie eintreffen."));
    for (const e of eintraege) liste.append(eintragZeichnen(e));
  } catch (e) { liste.textContent = "Fehler: " + e.message; }
}

document.querySelectorAll(".filter button").forEach((b) => {
  b.onclick = () => {
    filter = b.dataset.filter;
    document.querySelectorAll(".filter button").forEach((x) => x.classList.toggle("aktiv", x === b));
    listeLaden();
  };
});
$("test").onclick = async () => {
  try { await api("api/testlauf", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); testLief = true; meldung("Testlauf läuft …"); $("test").disabled = true; }
  catch (e) { meldung("Testlauf nicht gestartet: " + e.message); }
};

statusLaden();
listeLaden();
setInterval(statusLaden, 5000);
setInterval(listeLaden, 30000);
