/* Erzeugt die erfundenen Test-Mails in tests/fixtures/*.eml
       node tests/fixtures-erzeugen.mjs
   Alles ausgedacht: Beispieldomains (.example/.invalid-artig), 203.0.113.x
   und 198.51.100.x sind Dokumentationsadressen. Keine echte Mail. */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hier = dirname(fileURLToPath(import.meta.url));
const ziel = join(hier, "fixtures");
mkdirSync(ziel, { recursive: true });

/* Gmail setzt ganz oben seinen eigenen Authentication-Results-Kopf und
   nimmt die Mail über mx.google.com an. */
function mail({ von, an = "gregor@gmail.example", betreff, ip, helo, ergebnis, returnPath, teile }) {
  const rp = returnPath ?? von.match(/<([^>]+)>/)?.[1] ?? von;
  const kopf = [
    `Delivered-To: ${an}`,
    `Received: by 2002:a05:6a00:1234:b0:1ab:cd12:34ef with SMTP id abc123;`,
    `        Mon, 2 Nov 2026 08:00:01 -0800 (PST)`,
    `ARC-Authentication-Results: i=1; mx.google.com; ${ergebnis}`,
    `Return-Path: <${rp}>`,
    `Received: from ${helo} (${helo}. [${ip}])`,
    `        by mx.google.com with ESMTPS id x1si123456qkb.1.2026.11.02.08.00.00`,
    `        for <${an}>; Mon, 02 Nov 2026 08:00:00 -0800 (PST)`,
    `Authentication-Results: mx.google.com; ${ergebnis}`,
    `From: ${von}`,
    `To: ${an}`,
    `Subject: ${betreff}`,
    `Date: Mon, 2 Nov 2026 17:00:00 +0100`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@${helo}>`,
    `MIME-Version: 1.0`,
  ];
  return kopf.join("\r\n") + "\r\n" + teile + "\r\n";
}
const text = (t) => `Content-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${t}\r\n`;
const html = (h) => `Content-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${h}\r\n`;

/* Ein ZIP ohne Kompression (Methode 0) mit einer Datei */
function crc32(u8) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    c = (crc ^ u8[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipMit(name, inhalt) {
  const n = Buffer.from(name), d = Buffer.from(inhalt), crc = crc32(d);
  const lokal = Buffer.alloc(30);
  lokal.writeUInt32LE(0x04034b50, 0); lokal.writeUInt16LE(20, 4); lokal.writeUInt16LE(0, 6); lokal.writeUInt16LE(0, 8);
  lokal.writeUInt32LE(crc, 14); lokal.writeUInt32LE(d.length, 18); lokal.writeUInt32LE(d.length, 22); lokal.writeUInt16LE(n.length, 26);
  const zentral = Buffer.alloc(46);
  zentral.writeUInt32LE(0x02014b50, 0); zentral.writeUInt16LE(20, 4); zentral.writeUInt16LE(20, 6);
  zentral.writeUInt32LE(crc, 16); zentral.writeUInt32LE(d.length, 20); zentral.writeUInt32LE(d.length, 24); zentral.writeUInt16LE(n.length, 28);
  const ende = Buffer.alloc(22);
  const zentralStart = lokal.length + n.length + d.length;
  ende.writeUInt32LE(0x06054b50, 0); ende.writeUInt16LE(1, 8); ende.writeUInt16LE(1, 10);
  ende.writeUInt32LE(zentral.length + n.length, 12); ende.writeUInt32LE(zentralStart, 16);
  return Buffer.concat([lokal, n, d, zentral, n, ende]);
}

const dateien = {
  /* grün: bekannter Absender, Google bestätigt alles */
  "harmlos.eml": mail({
    von: "Max Muster <max.muster@beispiel-firma.example>", betreff: "Termin am Donnerstag",
    ip: "203.0.113.10", helo: "mail.beispiel-firma.example",
    ergebnis: "dkim=pass header.i=@beispiel-firma.example header.s=sel1 header.b=abcd; spf=pass (google.com: domain of max.muster@beispiel-firma.example designates 203.0.113.10 as permitted sender) smtp.mailfrom=max.muster@beispiel-firma.example; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=beispiel-firma.example",
    teile: text("Hallo Gregor,\r\n\r\npasst es dir am Donnerstag um 10 Uhr? Dann besprechen wir die Lieferung.\r\n\r\nGruß Max"),
  }),

  /* rot: paypa1-Link, Anzeigetext zeigt auf paypal.com, Ziel ist ein anderes */
  "paypal-phishing.eml": mail({
    von: "PayPal Service <service@paypa1-support.example>", betreff: "Ihr PayPal-Konto wurde eingeschränkt",
    ip: "198.51.100.77", helo: "mailer.paypa1-support.example",
    ergebnis: "dkim=none; spf=pass (google.com: domain of service@paypa1-support.example designates 198.51.100.77 as permitted sender) smtp.mailfrom=service@paypa1-support.example; dmarc=pass (p=NONE) header.from=paypa1-support.example",
    teile: html('<html><body><p>Sehr geehrter Kunde,</p><p>Ihr Konto wurde eingeschränkt. Bitte bestätigen Sie Ihr Passwort sofort:</p>'
      + '<p><a href="https://paypa1-login.example/verify?id=1">https://www.paypal.com/de/login</a></p></body></html>'),
  }),

  /* rot: Programm im ZIP */
  "zip-exe.eml": (() => {
    const grenze = "==grenze-zip==";
    const zip = zipMit("Rechnung_2026-11.exe", "MZ-nicht-wirklich-ein-programm").toString("base64").replace(/(.{76})/g, "$1\r\n");
    return mail({
      von: "Buchhaltung <rechnung@lieferant-beispiel.example>", betreff: "Rechnung November",
      ip: "203.0.113.55", helo: "mail.lieferant-beispiel.example",
      ergebnis: "dkim=pass header.i=@lieferant-beispiel.example; spf=pass smtp.mailfrom=rechnung@lieferant-beispiel.example; dmarc=pass header.from=lieferant-beispiel.example",
      teile: `Content-Type: multipart/mixed; boundary="${grenze}"\r\n\r\n--${grenze}\r\n${text("Anbei die Rechnung.")}--${grenze}\r\n`
        + `Content-Type: application/zip; name="Rechnung.zip"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="Rechnung.zip"\r\n\r\n${zip}\r\n--${grenze}--\r\n`,
    });
  })(),

  /* rot: Google meldet dmarc=fail für den angezeigten Absender */
  "dmarc-fail.eml": mail({
    von: "Sparkasse Beispielstadt <info@sparkasse-beispiel.example>", betreff: "Wichtige Mitteilung zu Ihrem Konto",
    ip: "198.51.100.200", helo: "vps123.hoster-beispiel.example",
    ergebnis: "dkim=none; spf=softfail (google.com: domain of transitioning info@sparkasse-beispiel.example does not designate 198.51.100.200 as permitted sender) smtp.mailfrom=info@sparkasse-beispiel.example; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=sparkasse-beispiel.example",
    teile: text("Guten Tag,\r\n\r\nbitte lesen Sie die angehängte Mitteilung.\r\n"),
  }),

  /* gelb: unbekannter Absender, Aufforderung zur Anmeldung, sonst sauber */
  "unbekannt-anmeldung.eml": mail({
    von: "Cloud Team <team@neuer-dienst-beispiel.example>", betreff: "Aktion nötig",
    ip: "203.0.113.99", helo: "mail.neuer-dienst-beispiel.example",
    ergebnis: "dkim=pass header.i=@neuer-dienst-beispiel.example; spf=pass smtp.mailfrom=team@neuer-dienst-beispiel.example; dmarc=pass header.from=neuer-dienst-beispiel.example",
    teile: text("Hallo,\r\n\r\nIhr Konto wurde eingeschränkt. Bitte bestätigen Sie Ihr Passwort, damit wir es wieder freischalten können.\r\n\r\nViele Grüße\r\nIhr Team"),
  }),

  /* Eine Mail, die einer Gmail-Fälschung ähnelt: ein Angreifer schreibt selbst
     einen "Authentication-Results: mx.google.com … dmarc=pass" in den Kopf –
     UNTER Googles echtem Kopf, der dmarc=fail sagt. Es gilt der oberste. */
  "gefaelschter-kopf.eml": mail({
    von: "Bank <info@bank-beispiel.example>", betreff: "Bitte prüfen",
    ip: "198.51.100.201", helo: "vps9.hoster-beispiel.example",
    ergebnis: "dkim=none; spf=fail smtp.mailfrom=info@bank-beispiel.example; dmarc=fail (p=REJECT) header.from=bank-beispiel.example",
    teile: text("Hallo.\r\n"),
  }).replace("From: Bank", "Authentication-Results: mx.google.com; dmarc=pass header.from=bank-beispiel.example\r\nFrom: Bank"),
};

for (const [name, inhalt] of Object.entries(dateien)) writeFileSync(join(ziel, name), inhalt);
console.log(Object.keys(dateien).length + " Fixtures geschrieben");
