# VoltimaxChat — Leitfaden zu DSGVO & Cookie-Einwilligung

## Überblick

VoltimaxChat (Groot) ist ein KI-gestützter Kundenservice-Chatbot, der in den Voltimax-Storefront eingebettet ist. Dieses Dokument beschreibt die Datenverarbeitung, Speicherung, Rechtsgrundlagen und Einwilligungsanforderungen gemäß EU-DSGVO für den Produktivbetrieb.

> **Hinweis:** Dieses Dokument ist eine technische Handreichung, keine Rechtsberatung. Lassen Sie es vor der Veröffentlichung durch eine:n Datenschutzbeauftragte:n oder Jurist:in prüfen — insbesondere die Aspekte KI-Verarbeitung und Drittlandübermittlung (USA).

---

## 1. Erhobene Daten

### Personenbezogene Daten (vom Kunden eingegeben)

| Daten | Erhebung | Zweck | Speicherung |
|-------|----------|-------|-------------|
| Name | Eingabe im Chat-Startbildschirm | Personalisierung der KI-Antworten, Ticket-Erstellung | MongoDB (Sitzung), Zendesk (Ticket) |
| E-Mail | Eingabe im Chat-Startbildschirm | Sitzungsidentität, Ticket-Erstellung, Bestellverifikation | MongoDB (Sitzung), Zendesk (Ticket) |
| IP-Adresse | Automatisch bei Einwilligung | Einwilligungsdokumentation (DSGVO) | Shopware-DB (`voltimax_chat_consent_log`) |

### Chat-Daten (während der Sitzung erzeugt)

| Daten | Zweck | Speicherung | Aufbewahrung |
|-------|-------|-------------|--------------|
| Chatnachrichten | KI-Gesprächsverlauf | MongoDB (`chat_messages`) | 90 Tage (konfigurierbar) |
| Sitzungs-Metadaten | Analyse, Themen-Tracking | MongoDB (`chat_sessions`) | 90 Tage |
| Sitzungsereignisse | Kartenaktionen, Verifikationen | MongoDB (session.events) | 90 Tage |
| Sternebewertungen | Servicequalitätsüberwachung | MongoDB (session.rating) | 90 Tage |
| Daumen hoch/runter | Bewertung der Antwortqualität | MongoDB (`analytics_events`) | 90 Tage |
| Bestellnummer + PLZ | Bestellverifikation | MongoDB (Sitzung, nicht langfristig gespeichert) | Sitzungsdauer |

### Hochgeladene Dateien

| Daten | Zweck | Speicherung |
|-------|-------|-------------|
| Batteriepfand-PDF-Formulare | Bearbeitung der Pfandrückgabe | Zendesk (Ticket-Anhang) |

### Browser-Speicher (nur clientseitig)

| Speicher | Schlüssel | Daten | Zweck | Ablauf |
|----------|-----------|-------|-------|--------|
| `localStorage` | `voltimax_chat_user` | Name, E-Mail, Zeitstempel | Wiederkehrende Nutzer merken (24 Std.) | 24 Stunden |
| `localStorage` | `voltimax_chat_id` | Chat-ID (z. B. #A1B2C3D4) | Referenz der Chat-Sitzung | beim Schließen des Chats |
| `sessionStorage` | `voltimax_chat_session` | Sitzungsstatus, Nachrichten | Chat über Seitennavigation erhalten | beim Schließen des Tabs |

### Weitergabe an Drittanbieter

| Dienst | Weitergegebene Daten | Zweck | Rechtsgrundlage |
|--------|----------------------|-------|-----------------|
| **Anthropic (Claude)** | Chatnachrichten (voller Wortlaut) | KI-Antwortgenerierung | Einwilligung / berechtigtes Interesse |
| **OpenAI** | Anfragetext (für Embeddings) | Wissensdatenbank-Suche (RAG) | Einwilligung / berechtigtes Interesse |
| **LangSmith (EU-Region)** | Chat-Traces, Prompts, Antworten — Speicherung in der EU (`eu.api.smith.langchain.com`) | Qualitätsüberwachung & Debugging der KI | berechtigtes Interesse |
| **Zendesk** | Name, E-Mail, Chat-Transkript, Datei-Uploads | Support-Ticket-Erstellung | Vertragserfüllung |

> **Wichtige Klarstellungen (Genauigkeit):**
> - **Keine Anonymisierung.** Chatnachrichten werden an Anthropic, OpenAI und LangSmith **im vollen Wortlaut** übermittelt — einschließlich aller vom Kunden eingegebenen Namen, E-Mail-Adressen oder Bestellnummern. Lediglich die Chat-ID (z. B. `#A1B2C3D4`) ist ein Pseudonym. Diese Daten dürfen **nicht** als „anonymisiert" bezeichnet werden.
> - **Kein Modelltraining.** Anthropic und OpenAI verwenden über die API übermittelte Daten standardmäßig **nicht** zum Training ihrer Modelle.
> - **MongoDB ist kein Drittanbieter.** Die Datenbank (`atlas-local`) wird **selbst gehostet auf Ihrem eigenen Hetzner-Server** — Sitzungsdaten werden nicht an MongoDB Inc. oder Atlas Cloud weitergegeben. Hetzner (Hosting) ist der einzige Infrastruktur-Unterauftragsverarbeiter; siehe §6.

---

## 2. Rechtsgrundlagen (Art. 6 DSGVO)

| Verarbeitungstätigkeit | Rechtsgrundlage | DSGVO-Artikel |
|------------------------|-----------------|---------------|
| Chat-Konversation | **Einwilligung** (Kunde startet den Chat und stimmt zu) | Art. 6 Abs. 1 lit. a |
| Bestellverifikation | **Vertragserfüllung** (Bestellung des Kunden) | Art. 6 Abs. 1 lit. b |
| Ticket-Erstellung | **Vertragserfüllung** (Supportanfrage des Kunden) | Art. 6 Abs. 1 lit. b |
| KI-Antwortgenerierung | **Berechtigtes Interesse** (effizienter Kundenservice) | Art. 6 Abs. 1 lit. f |
| Analyse & Qualitätsüberwachung | **Berechtigtes Interesse** (Serviceverbesserung) | Art. 6 Abs. 1 lit. f |
| Einwilligungsprotokollierung | **Rechtliche Verpflichtung** (DSGVO-Rechenschaftspflicht) | Art. 6 Abs. 1 lit. c |

---

## 3. Umsetzung der Einwilligung

### 3.1 Einwilligungshinweis im Chat (bereits implementiert)

Das Chat-Widget zeigt im Startbildschirm einen Einwilligungshinweis in der Fußzeile:

```
„Mit der Fortsetzung stimmen Sie unserer Datenschutzerklärung zu."
```

**Aktuelle Umsetzung:**
- Anzeige am unteren Rand des Chat-Startbildschirms
- Verlinkung zur Datenschutzerklärung (in den Plugin-Einstellungen konfigurierbar)
- Die Einwilligung wird in der Tabelle `voltimax_chat_consent_log` protokolliert mit:
  - E-Mail des Kunden
  - Name des Kunden
  - IP-Adresse
  - Zeitstempel
  - Sales-Channel-ID

### 3.2 Empfohlener Datenschutz-Text (Deutsch)

Fügen Sie diesen Abschnitt Ihrer **Datenschutzerklärung** hinzu:

```
Einsatz des VoltimaxChat Chatbots (Groot)

Auf unserer Website setzen wir einen KI-gestützten Chatbot („Groot") ein, um 
Ihnen schnell und effizient bei Fragen zu Produkten, Bestellungen und Service-
anfragen zu helfen.

Verarbeitete Daten:
• Name und E-Mail-Adresse (von Ihnen eingegeben)
• Chatnachrichten und Gesprächsverlauf
• Bestellnummer und Postleitzahl (bei Bestellverifikation)
• IP-Adresse (für die Einwilligungsdokumentation)
• Hochgeladene Dateien (z. B. Batteriepfand-Formulare)

Zweck der Verarbeitung:
• Beantwortung Ihrer Anfragen mittels KI-gestützter Textgenerierung
• Bestellverfolgung und Auftragsverifikation
• Erstellung von Support-Tickets bei Zendesk
• Qualitätsverbesserung unseres Kundenservice

Rechtsgrundlage:
Die Verarbeitung erfolgt auf Grundlage Ihrer Einwilligung (Art. 6 Abs. 1 lit. a 
DSGVO), die Sie durch die Nutzung des Chatbots erteilen, sowie zur Vertrags-
erfüllung (Art. 6 Abs. 1 lit. b DSGVO) bei bestellbezogenen Anfragen.

Drittanbieter:
Für die KI-Textgenerierung nutzen wir Dienste von Anthropic (Claude) und OpenAI. 
Ihre Nachrichten werden im vollen Wortlaut zur Verarbeitung an diese Dienste 
übermittelt. Die Übermittlung in die USA erfolgt auf Grundlage von Standard-
vertragsklauseln (SCCs). Die Anbieter verwenden über die API übermittelte Daten 
standardmäßig nicht zum Training ihrer Modelle.

Für die Qualitätsüberwachung nutzen wir LangSmith (LangChain Inc.). Die 
Verarbeitung erfolgt in der EU-Region; Chatverläufe werden dort gespeichert, 
um die Antwortqualität zu verbessern.

Support-Tickets werden bei Zendesk (Zendesk Inc.) erstellt, wenn eine Eskalation 
an unser Support-Team erfolgt.

Speicherdauer:
Chatverläufe werden 90 Tage nach Sitzungsende automatisch gelöscht. 
Einwilligungsprotokolle werden gemäß der gesetzlichen Aufbewahrungspflicht 
für 3 Jahre gespeichert.

Ihre Rechte:
Sie haben das Recht auf Auskunft, Berichtigung, Löschung und Einschränkung 
der Verarbeitung Ihrer Daten sowie das Recht auf Datenübertragbarkeit und 
Widerspruch. Zur Ausübung Ihrer Rechte kontaktieren Sie uns unter: 
info@voltimax.de

Sie können den Chat jederzeit schließen, um die Datenverarbeitung zu beenden.
```

---

## 4. Einbindung in den Cookie-Consent-Banner

### 4.1 Was VoltimaxChat verwendet (KEINE Cookies)

VoltimaxChat setzt **keine** HTTP-Cookies. Es verwendet:
- `localStorage` — zum Merken wiederkehrender Nutzer (24 Std.)
- `sessionStorage` — zum Erhalt des Chats bei Seitennavigation (nur Tab)

Nach der ePrivacy-Richtlinie (und § 25 TTDSG) werden `localStorage` und `sessionStorage` wie Cookies behandelt — sie erfordern eine Einwilligung, sofern sie nicht unbedingt erforderlich sind.

### 4.2 Einordnung

| Speicher | Unbedingt erforderlich? | Einwilligung nötig? |
|----------|-------------------------|---------------------|
| `sessionStorage` (Chat-Status) | **Ja** — für die seitenübergreifende Funktion des Chats erforderlich | **Nein** — ausgenommen nach § 25 Abs. 2 Nr. 2 TTDSG |
| `localStorage` (wiederkehrende Nutzer) | **Nein** — Komfortfunktion | **Ja** — erfordert Einwilligung |

### 4.3 Integration in den Shopware-Cookie-Consent

Fügen Sie VoltimaxChat Ihrer Cookie-Consent-Konfiguration hinzu (z. B. Consentmanager, Cookiebot oder Shopware-eigener Cookie-Consent):

**Cookie-/Speicher-Eintrag:**

```
Name:        VoltimaxChat
Kategorie:   Funktional / Komfort
Anbieter:    Voltimax (First Party / Erstanbieter)
Zweck:       KI-Chatbot für Kundenservice. Speichert Name und E-Mail für 
             wiederkehrende Besucher (24 Stunden) und Chat-Sitzungsdaten 
             für die Navigation zwischen Seiten.
Speicher:    localStorage (voltimax_chat_user, voltimax_chat_id)
             sessionStorage (voltimax_chat_session)
Dauer:       localStorage: 24 Stunden / sessionStorage: Browser-Sitzung
Datenschutz: https://voltimax.de/datenschutz
```

### 4.4 Bedingtes Laden nach Einwilligung

Wenn das Chat-Widget erst nach erteilter Cookie-Einwilligung geladen werden soll, ergänzen Sie Ihr Shopware-Theme oder -Plugin:

```javascript
// VoltimaxChat erst nach erteilter Einwilligung initialisieren
// Beispiel mit Shopware Cookie-Consent:
document.addEventListener('CookieConfiguration_Update', function(event) {
    if (event.detail && event.detail.voltimax_chat) {
        // Nutzer hat eingewilligt — Widget initialisieren
        window.PluginManager.initializePlugin('VoltimaxChatPlugin', '[data-voltimax-chat]');
    }
});
```

Oder mit Consentmanager/Cookiebot:
```javascript
// Cookiebot-Beispiel
window.addEventListener('CookiebotOnAccept', function() {
    if (Cookiebot.consent.preferences) {
        window.PluginManager.initializePlugin('VoltimaxChatPlugin', '[data-voltimax-chat]');
    }
});
```

---

## 5. Checkliste Betroffenenrechte (DSAR)

Wenn ein Kunde Auskunft über seine Daten oder deren Löschung verlangt:

### Auskunftsrecht (Art. 15)
- [ ] Chat-Sitzungen aus MongoDB exportieren: `db.chat_sessions.find({customer_email: "..."})`
- [ ] Chatnachrichten exportieren: `db.chat_messages.find({session_id: {$in: [session_ids]}})`
- [ ] Einwilligungsprotokoll exportieren: `SELECT * FROM voltimax_chat_consent_log WHERE customer_email = '...'`
- [ ] Zendesk auf per E-Mail erstellte Tickets prüfen
- [ ] LangSmith auf Traces prüfen (Suche über Metadaten `customer_email`)

### Recht auf Löschung (Art. 17)
- [ ] Aus MongoDB löschen: Sitzungen, Nachrichten, Analyse-Ereignisse
- [ ] Aus Shopware löschen: `voltimax_chat_consent_log`
- [ ] Aus Zendesk löschen: Tickets schließen/löschen (falls zutreffend)
- [ ] Aus LangSmith löschen: Traces entfernen (falls identifizierbar)
- [ ] Zwischengespeicherte Daten leeren: `POST /cache/clear`

### Automatisierte Löschung
Der KI-Dienst löscht alte Sitzungen nach Ablauf der konfigurierten Aufbewahrungsfrist (Standard: 90 Tage) automatisch. Dies läuft täglich über den Hintergrund-Task (`tasks/purge.py`).

---

## 6. Auftragsverarbeitungsverträge (AVV / DPA)

Stellen Sie sicher, dass AVVs vorliegen mit:

| Anbieter | Zweck | AVV-Link |
|----------|-------|----------|
| **Anthropic** | KI-Antwortgenerierung | https://www.anthropic.com/policies/privacy |
| **OpenAI** | Text-Embeddings für RAG | https://openai.com/policies/data-processing-addendum |
| **LangChain (LangSmith)** | KI-Tracing & Monitoring (EU-Region) | https://www.langchain.com/legal |
| **Zendesk** | Support-Ticket-Verwaltung | https://www.zendesk.com/company/data-processing-form/ |
| **Hetzner** | Server-Hosting (alle Daten inkl. selbst gehostetem MongoDB) | https://www.hetzner.com/legal/privacy-policy |

> MongoDB läuft selbst gehostet (`atlas-local`) auf dem Hetzner-Server — ein separater AVV mit MongoDB Atlas / Cloud ist nicht erforderlich. Bei einer künftigen Migration zu MongoDB Atlas Cloud ergänzen Sie deren AVV: https://www.mongodb.com/legal/dpa

---

## 7. Zusammenfassung für die Plugin-Konfiguration

In **Shopware Admin → Erweiterungen → VoltimaxChat → Konfiguration**:

| Einstellung | Empfohlener Wert |
|-------------|------------------|
| `consentText` | „Durch die Nutzung des Chats stimmen Sie unserer Datenschutzerklärung zu." |
| `privacyPolicyUrl` | `https://voltimax.de/datenschutz` |
| `consentCheckboxLabel` | „Ich stimme der Verarbeitung meiner Daten zu" |

---

## 8. Technische und organisatorische Maßnahmen (Art. 32)

| Maßnahme | Umsetzung |
|----------|-----------|
| Verschlüsselung bei Übertragung | HTTPS/WSS via Let's-Encrypt-SSL |
| Verschlüsselung im Ruhezustand | MongoDB-Daten auf verschlüsseltem Hetzner-Speicher |
| Zugriffskontrolle | JWT-Authentifizierung, API-Key-Prüfung |
| Ratenbegrenzung | Limits pro Sitzung und pro Minute |
| Datenminimierung | Nur Name + E-Mail erhoben, keine unnötigen Felder |
| Pseudonymisierung | Chat-IDs sind zufällige Hashes, keine personenbezogenen Daten |
| Aufbewahrungsgrenzen | Automatische Löschung nach 90 Tagen |
| Einwilligungsprotokollierung | IP + Zeitstempel + E-Mail in Shopware-DB gespeichert |
| Recht auf Löschung | MongoDB-Löschskripte verfügbar |
| Prüfpfad (Audit-Trail) | LangSmith-Traces, Sitzungsereignisse, Analyse-Ereignisse |

---

## 9. Noch zu erledigen (durch den Betreiber zu bestätigen)

- [ ] Datenschutzerklärung unter `https://voltimax.de/datenschutz` erstellen/ergänzen (Abschnitt aus §3.2 einfügen)
- [ ] DSAR-Kontaktadresse bestätigen (`info@voltimax.de`)
- [ ] AVVs mit allen Anbietern aus §6 tatsächlich abschließen
- [ ] Diesen Leitfaden juristisch prüfen lassen (KI- & Drittlandübermittlung)
