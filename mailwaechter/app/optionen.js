import { readFileSync } from "node:fs";
import { istFreemail } from "./regeln/mailDomain.js";

/* Optionen aus /data/options.json (Home Assistant schreibt sie dorthin).
   Lokal: OPTIONS_FILE zeigt auf eine eigene Datei. */
export function optionenLesen(pfad = process.env.OPTIONS_FILE || "/data/options.json") {
  let roh = {};
  try { roh = JSON.parse(readFileSync(pfad, "utf8")); } catch { /* ohne Datei: Vorgaben */ }
  return optionenNormalisieren(roh);
}

const liste = (v) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean);

export function optionenNormalisieren(roh = {}) {
  return {
    gmailAdresse: String(roh.gmail_adresse || "").trim().toLowerCase(),
    appPasswort: String(roh.app_passwort || "").replace(/\s+/g, ""),
    benachrichtigung: String(roh.benachrichtigung || "").trim(),
    meldenBei: roh.melden_bei === "gelb" ? "gelb" : "rot",
    nurMelden: roh.nur_melden === true,
    /* gmail.com & Co. gehören nie „dir“ – sonst wäre jede Freemail-Mail rot */
    eigeneDomains: liste(roh.eigene_domains).map((d) => d.toLowerCase().replace(/^@/, "")).filter((d) => !istFreemail(d)),
    geschuetzteNamen: liste(roh.geschuetzte_namen),
    bekannteDomains: liste(roh.bekannte_domains).map((d) => d.toLowerCase().replace(/^@/, "")),
    rdap: roh.rdap !== false,
    sperrlisten: roh.sperrlisten !== false,
    logLevel: ["debug", "info", "warning", "error"].includes(roh.log_level) ? roh.log_level : "info",
  };
}
