import { log } from "./log.js";

/* Eine Nachricht über den Home-Assistant-Dienst aus der Option
   `benachrichtigung` (z. B. notify.mobile_app_xyz), über die Supervisor-API.
   Inhalt: Absender, Betreff, wichtigster Grund. `holen` ist fetch (Tests
   spielen es vor). */
export async function melden(optionen, { von, betreff, stufe, grund, aktion }, { holen = fetch, token = process.env.SUPERVISOR_TOKEN, basis = "http://supervisor/core/api" } = {}) {
  if (!optionen.benachrichtigung) return false;
  if (stufe === "gelb" && optionen.meldenBei !== "gelb") return false;
  if (stufe !== "rot" && stufe !== "gelb") return false;
  const [dom, ...rest] = optionen.benachrichtigung.split(".");
  const dienst = rest.join(".");
  if (!dom || !dienst) { log.warning("Benachrichtigung unbrauchbar (erwartet notify.<dienst>)"); return false; }
  if (!token) { log.warning("Kein SUPERVISOR_TOKEN – keine Benachrichtigung"); return false; }
  const titel = stufe === "rot" ? "Gefährliche Mail" : "Verdächtige Mail";
  const nachricht = `${von} – ${betreff || "(kein Betreff)"}\n${grund || ""}${aktion ? `\n(${aktion})` : ""}`.trim();
  try {
    const a = await holen(`${basis}/services/${dom}/${dienst}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: titel, message: nachricht }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!a.ok) { log.warning(`Benachrichtigung: HTTP ${a.status}`); return false; }
    return true;
  } catch (e) {
    log.warning("Benachrichtigung gescheitert:", e);
    return false;
  }
}
