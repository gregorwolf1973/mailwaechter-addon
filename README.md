# Mailwächter – Home-Assistant-Add-on

Überwacht ein Gmail-Postfach per IMAP IDLE, prüft jede neue Mail mit den
Regeln der Mailprüfung aus dem Planungstool und verschiebt gefährliche Mails
in das Label „Gefahr“.

Installation: Einstellungen → Add-ons → Add-on-Store → ⋮ → Repositories →
`https://github.com/gregorwolf1973/mailwaechter-addon`.

Beschreibung, Optionen und Einrichtung: [mailwaechter/DOCS.md](mailwaechter/DOCS.md).

## Entwickeln

```
cd mailwaechter && npm install
npm test                          # node:test, erfundene .eml unter tests/fixtures
node ../scripts/regeln-holen.mjs  # Prüfregeln aus dem Planungstool abgleichen
```

Lokal starten: `DATA_DIR=./data OPTIONS_FILE=./options.json PORT=8099 node mailwaechter/app/server.js`
(`options.json` mit den Schlüsseln aus `config.yaml`). Node 20 oder neuer.

`mailwaechter/app/regeln/` ist **kopiert** und wird nicht von Hand geändert.
