# Mailwächter

Überwacht dein privates Gmail-Postfach per IMAP IDLE. Jede **neue** Mail wird
mit den Regeln der Mailprüfung aus dem Planungstool geprüft (Absender, Weg der
Mail, Links, Anhänge, Text). Gefährliche Mails werden verschoben, verdächtige
beschriftet.

## Was passiert mit einer Mail?

| Ergebnis | Aktion |
|---|---|
| **Rot** (gefährlich) | Label „Gefahr“ (wird angelegt), Mail aus dem Posteingang entfernt |
| **Gelb** (verdächtig) | bleibt im Posteingang, zusätzlich Label „Prüfen“ |
| Grün / Info | nichts |

Mit `nur_melden` wird nichts verschoben oder beschriftet, nur protokolliert.
Beim allerersten Start wird **nichts Altes** angefasst – geprüft wird, was
danach eintrifft.

## Einrichten

1. In Gmail: Einstellungen → Weiterleitung und POP/IMAP → **IMAP aktivieren**.
2. Im Google-Konto die Bestätigung in zwei Schritten einschalten und ein
   **App-Passwort** erzeugen (Sicherheit → App-Passwörter). Das normale
   Kennwort funktioniert nicht.
3. Optionen ausfüllen: `gmail_adresse`, `app_passwort`, optional
   `benachrichtigung` (z. B. `notify.mobile_app_pixel_8`).
4. Zum Ausprobieren zuerst `nur_melden: true` setzen und in der Oberfläche
   „Letzte 50 Mails jetzt prüfen (nur melden)“ drücken.

Das App-Passwort wird nie protokolliert.

## Optionen

- `gmail_adresse`, `app_passwort` – Zugang (imap.gmail.com:993).
- `benachrichtigung` – HA-Dienst, z. B. `notify.mobile_app_xyz`; Text:
  Absender, Betreff, wichtigster Grund. `melden_bei`: `rot` oder `gelb`
  (gelb meldet auch Rot).
- `nur_melden` – nichts verschieben (Standard aus).
- `eigene_domains` – Domains, die dir gehören. Eine Mail mit so einem Absender,
  die von außen kommt, gilt als Fälschung.
- `geschuetzte_namen` – Namen, die in fremden Adressen als Täuschung gelten
  (z. B. „Gregor Wolf“, Familie, Chef).
- `bekannte_domains` – gelten immer als bekannter Absender.
- `rdap` – Alter der Domain bei der Registrierungsstelle erfragen (nur der
  Domainname geht hinaus).
- `sperrlisten` – Spamhaus DROP und Feodo Tracker für den sendenden Rechner.
- `log_level`.

## Wie geprüft wird

- **Googles eigenes Urteil**: der oberste `Authentication-Results`-Kopf von
  `mx.google.com` gilt als verlässlich. `dmarc=fail` oder `spf=fail` mit
  passender Absenderdomain ist **rot**. Köpfe weiter unten schreibt der
  Absender selbst und zählen nicht.
- **Bekannte Absender**: beim Start und einmal täglich werden aus dem
  Gesendet-Ordner (\Sent) **nur die Empfängeradressen** (Umschlag To/Cc der
  letzten 2 Jahre) gelesen und als Domains in `/data` gemerkt. Daraus speist
  sich „bekannt“ und „ähnlich einer bekannten Domain“ (`paypa1.com`).
- **Netz**: SPF und DMARC im DNS, Domainalter (RDAP), Spamhaus DROP/Feodo –
  mit Zwischenspeicher. Es gehen nur Domainnamen und die Adresse des
  sendenden Rechners hinaus, **nie ein Mailinhalt**, und an keine KI.
- Regeln für Links (Anzeige ≠ Ziel, Verwechslungsdomains, Kurzlinks),
  Anhänge (Programme, doppelte Endungen, Archive, Makros), Text (Bankdaten,
  Anmeldung, Chef-Betrug) und IBAN-Prüfziffern.

Ein grünes Urteil ist keine Garantie.

## Oberfläche (Seitenleiste)

Liste der geprüften Mails mit Ampel und Gründen, Filter Rot/Gelb/Alle,
Verbindungsstatus. **Zurückholen** legt die Mail zurück in den Posteingang,
nimmt die Labels weg und merkt die Absenderdomain künftig als bekannt.
Das Protokoll liegt in `/data` und wird nach 90 Tagen gelöscht.

## Regeln abgleichen

Die Prüfregeln sind aus dem Planungstool kopiert (`app/regeln/`). Neu holen:
`node scripts/regeln-holen.mjs`, danach `git diff` ansehen und Tests laufen
lassen. Die kleinen Anpassungen für Gmail stehen im Skript.
