# Änderungen

## 0.2.0

- Ausführlicher Prüfbericht je Mail: Ampel und Urteil, „Geprüft wurde“, alle Befunde
  nach Gruppen (auch grüne), Links und Anhänge, Einzelheiten zur Herkunft.
  Aufruf über „Bericht“ an jedem Eintrag; „Zurückholen“ auch dort.
- Der Bericht liegt im Protokoll (höchstens ca. 8 KB je Mail, kein Mailtext).
  Ältere Einträge zeigen nur die Gründe.
- Neuer Endpunkt `GET api/eintrag?id=…`; die Liste bleibt ohne Bericht.

## 0.1.0

- Erste Fassung: IMAP IDLE auf Gmail, Prüfung neuer Mails mit den Regeln der
  Mailprüfung aus dem Planungstool, rot → Label „Gefahr“ (verschoben), gelb →
  Label „Prüfen“, Option `nur_melden`.
- Googles `Authentication-Results` (mx.google.com) als verlässliche Aussage.
- Bekannte Absender aus dem Gesendet-Ordner (nur Empfänger-Domains).
- Domainalter (RDAP), Spamhaus DROP, Feodo Tracker.
- Oberfläche mit Liste, Filter, „Zurückholen“ und Testlauf über die letzten 50 Mails.
- Benachrichtigung über einen HA-Dienst.
