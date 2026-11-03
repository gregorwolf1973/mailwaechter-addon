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
  const a = el("div", "aktionen");
  const bk = el("button", "", "Bericht");
  bk.title = "Ausführlicher Prüfbericht zu dieser Mail";
  bk.onclick = () => detailOeffnen(e.id);
  a.append(bk);
  if ((e.stufe === "rot" || e.stufe === "gelb") && !e.zurueckgeholt) a.append(zurueckholKnopf(e, () => listeLaden()));
  karte.append(a);
  return karte;
}

function zurueckholKnopf(e, danach) {
  const knopf = el("button", "", "Zurückholen");
  knopf.title = "Mail zurück in den Posteingang, Labels entfernen, Absenderdomain künftig als bekannt merken";
  knopf.onclick = async () => {
    knopf.disabled = true;
    try {
      const r = await api("api/zurueckholen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id }) });
      meldung("Zurückgeholt." + (r.domainGemerkt ? ` ${r.domainGemerkt} gilt künftig als bekannt.` : ""));
      danach();
    } catch (err) { meldung("Zurückholen gescheitert: " + err.message); knopf.disabled = false; }
  };
  return knopf;
}

async function listeLaden() {
  if (!$("detail").hidden) return;
  const liste = $("liste");
  try {
    const { eintraege } = await api("api/eintraege?filter=" + filter);
    liste.textContent = "";
    if (!eintraege.length) liste.append(el("p", "leer", "Noch nichts geprüft – neue Mails erscheinen hier, sobald sie eintreffen."));
    for (const e of eintraege) liste.append(eintragZeichnen(e));
  } catch (e) { liste.textContent = "Fehler: " + e.message; }
}

/* ---------- Detailansicht: der Prüfbericht einer Mail (alles per textContent) ---------- */
const GRUPPEN = ["Absender", "Weg der Mail", "Links", "Anhänge", "Inhalt"];
const STUFE_TEXT = { rot: "Gefährlich", gelb: "Verdächtig", gruen: "In Ordnung", info: "Hinweis" };

function punkt(stufe) { const p = el("span", "punkt " + (stufe || "")); p.title = STUFE_TEXT[stufe] || ""; return p; }
function abschnitt(titel, offen) {
  const d = el("details", "abschnitt");
  if (offen) d.open = true;
  d.append(el("summary", "", titel));
  return d;
}
function zeileTab(tab, was, wert) {
  if (!wert) return;
  const tr = el("tr");
  tr.append(el("td", "", was), el("td", "", wert));
  tab.append(tr);
}
const kB = (n) => (n ? ` · ${n < 1024 ? n + " B" : (n / 1024).toFixed(0) + " kB"}` : "");
const auffaellig = (x) => x.stufe === "rot" || x.stufe === "gelb";

function befundZeile(stufe, titel, text) {
  const f = el("div", "befund");
  f.title = STUFE_TEXT[stufe] || "";
  const r = el("div");
  r.append(el("b", "", titel));
  if (text) r.append(document.createElement("br"), text);
  f.append(punkt(stufe), r);
  return f;
}

function detailZeichnen(e) {
  const v = $("detail");
  v.textContent = "";
  const oben = el("div", "d-oben");
  const zurueck = el("button", "", "← Zurück zur Liste");
  zurueck.onclick = detailSchliessen;
  oben.append(zurueck);
  if ((e.stufe === "rot" || e.stufe === "gelb") && !e.zurueckgeholt) oben.append(zurueckholKnopf(e, detailSchliessen));
  v.append(oben);

  const kopf = el("div", "d-kopf");
  kopf.append(el("div", "d-betreff", e.betreff || "(kein Betreff)"));
  const z = (was, wert) => { if (!wert) return; const x = el("div", "d-zeile"); x.append(el("b", "", was), wert); kopf.append(x); };
  z("Von", e.von);
  z("Zeit", zeit(e.zeit));
  z("Aktion", e.aktion + (e.test ? " (Testlauf)" : "") + (e.zurueckgeholt ? " · zurückgeholt" : ""));
  v.append(kopf);

  const b = e.bericht;
  if (!b || b.fehler) {
    const u = el("div", "urteil " + (auffaellig(e) ? e.stufe : ""));
    const h = el("h2");
    h.append(punkt(e.stufe), AMPEL[e.stufe] || e.stufe);
    u.append(h, el("p", "", b?.fehler ? "Prüfung gescheitert: " + b.fehler : "Bericht erst ab Version 0.2.0 – für diese Mail sind nur die Gründe gespeichert."));
    v.append(u);
    const gr = e.gruende || [];
    if (gr.length) {
      const sek = el("div", "gruppe");
      for (const g of gr) sek.append(befundZeile(g.stufe, g.titel, g.text));
      v.append(sek);
    }
    return;
  }

  const u = el("div", "urteil " + b.stufe);
  const h = el("h2");
  h.append(punkt(b.stufe), b.urteil?.titel || "");
  u.append(h, el("p", "", b.urteil?.text || ""), el("div", "geprueft", "Geprüft wurde: " + (b.geprueft || []).join(" · ")));
  v.append(u);

  for (const gruppe of GRUPPEN) {
    const bf = (b.befunde || []).filter((x) => x.gruppe === gruppe);
    if (!bf.length) continue;
    const auff = bf.some(auffaellig);
    const sek = abschnitt(gruppe + (auff ? "" : " – in Ordnung"), auff);
    for (const x of bf) sek.append(befundZeile(x.stufe, x.titel, x.text));
    v.append(sek);
  }

  const links = b.links || [];
  if (links.length) {
    const n = links.filter(auffaellig).length;
    const gesamt = b.linksGesamt || links.length;
    const ld = abschnitt(`Links (${gesamt}${n ? `, ${n} auffällig` : ""})`, n > 0);
    const lt = el("table", "tab");
    for (const l of links) {
      const tr = el("tr");
      const t1 = el("td");
      t1.append(punkt(l.stufe));
      const t2 = el("td");
      t2.append(el("div", "", l.anzeige ? `„${l.anzeige}“ →` : "(ohne Anzeige) →"));
      /* nur als Text, nie als anklickbarer Link */
      t2.append(el("div", "ziel", l.ziel || "(kein Ziel)"));
      for (const g of l.gruende || []) t2.append(el("div", "meta " + l.stufe, g));
      tr.append(t1, t2);
      lt.append(tr);
    }
    ld.append(lt);
    if (gesamt > links.length) ld.append(el("p", "meta", `Nur die ersten ${links.length} von ${gesamt} Links gespeichert.`));
    v.append(ld);
  }
  const anh = b.anhaenge || [];
  if (anh.length) {
    const n = anh.filter(auffaellig).length;
    const ad = abschnitt(`Anhänge (${anh.length}${n ? `, ${n} auffällig` : ""})`, n > 0);
    const at = el("table", "tab");
    for (const x of anh) {
      const tr = el("tr");
      const t1 = el("td");
      t1.append(punkt(x.stufe));
      const t2 = el("td");
      t2.append(el("div", "", x.name + kB(x.groesse)));
      for (const g of x.gruende || []) t2.append(el("div", "meta " + x.stufe, g));
      tr.append(t1, t2);
      at.append(tr);
    }
    ad.append(at);
    v.append(ad);
  }

  const ei = b.einzelheiten || {};
  const d = abschnitt("Einzelheiten");
  const tab = el("table", "tab");
  zeileTab(tab, "Absender", ei.absender);
  zeileTab(tab, "Antwort an", ei.antwortAn);
  zeileTab(tab, "Return-Path", ei.returnPath);
  zeileTab(tab, "Mailfrom (Google)", ei.mailfrom);
  if (ei.rechner) zeileTab(tab, "Sendender Rechner", `${ei.rechner.ip}${ei.rechner.name ? " · " + ei.rechner.name : ""}${ei.rechner.helo && ei.rechner.helo !== ei.rechner.name ? " · HELO " + ei.rechner.helo : ""}`);
  zeileTab(tab, "SPF (nachgeprüft)", ei.spf);
  zeileTab(tab, "DMARC", ei.dmarc);
  if (ei.google) zeileTab(tab, "Google meldet", `SPF ${ei.google.spf || "–"} · DKIM ${ei.google.dkim || "–"} · DMARC ${ei.google.dmarc || "–"}`);
  zeileTab(tab, "Datum", ei.datum ? zeit(ei.datum) : "");
  d.append(tab);
  v.append(d);
  if (b.gekuerzt) v.append(el("p", "meta", "Der gespeicherte Bericht wurde wegen seiner Größe gekürzt."));
}

async function detailOeffnen(id) {
  try {
    const { eintrag } = await api("api/eintrag?id=" + encodeURIComponent(id));
    detailZeichnen(eintrag);
    $("ansichtListe").hidden = true;
    $("detail").hidden = false;
    window.scrollTo(0, 0);
  } catch (err) { meldung("Bericht nicht geladen: " + err.message); }
}
function detailSchliessen() {
  $("detail").hidden = true;
  $("ansichtListe").hidden = false;
  listeLaden();
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
