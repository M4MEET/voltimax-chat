# VoltimaxChat — GDPR & Cookie Consent Guide

## Overview

VoltimaxChat (Groot) is an AI-powered customer support chatbot embedded in the Voltimax storefront. This document outlines the data processing, storage, legal basis, and consent requirements under EU GDPR (DSGVO) for production deployment.

---

## 1. Data Collected

### Personal Data (entered by customer)

| Data | Where collected | Purpose | Stored in |
|------|----------------|---------|-----------|
| Name | Chat home screen input | Personalise AI responses, ticket creation | MongoDB (session), Zendesk (ticket) |
| Email | Chat home screen input | Session identity, ticket creation, order verification | MongoDB (session), Zendesk (ticket) |
| IP address | Automatic on consent | GDPR consent log | Shopware DB (`voltimax_chat_consent_log`) |

### Chat Data (generated during session)

| Data | Purpose | Stored in | Retention |
|------|---------|-----------|-----------|
| Chat messages | AI conversation history | MongoDB (`chat_messages`) | 90 days (configurable) |
| Session metadata | Analytics, topic tracking | MongoDB (`chat_sessions`) | 90 days |
| Session events | Card actions, verifications | MongoDB (session.events array) | 90 days |
| Star ratings | Service quality monitoring | MongoDB (session.rating) | 90 days |
| Thumbs up/down feedback | Response quality tracking | MongoDB (`analytics_events`) | 90 days |
| Order number + postcode | Order verification | MongoDB (session, not persisted long-term) | Session duration |

### Uploaded Files

| Data | Purpose | Stored in |
|------|---------|-----------|
| Batteriepfand PDF forms | Deposit return processing | Zendesk (ticket attachment) |

### Browser Storage (client-side only)

| Storage | Key | Data | Purpose | Expires |
|---------|-----|------|---------|---------|
| `localStorage` | `voltimax_chat_user` | Name, email, timestamp | Remember returning users (24h) | 24 hours |
| `localStorage` | `voltimax_chat_id` | Chat ID (e.g. #A1B2C3D4) | Chat session reference | On chat close |
| `sessionStorage` | `voltimax_chat_session` | Session state, messages | Preserve chat across page navigation | On tab close |

### Third-Party Data Sharing

| Service | Data shared | Purpose | Legal basis |
|---------|-------------|---------|-------------|
| **Anthropic (Claude)** | Chat messages (anonymised) | AI response generation | Legitimate interest / Consent |
| **OpenAI** | Message text (for embedding) | Knowledge base search (RAG) | Legitimate interest / Consent |
| **LangSmith** | Chat traces, prompts, responses | AI quality monitoring & debugging | Legitimate interest |
| **Zendesk** | Name, email, chat transcript, file uploads | Support ticket creation | Contract performance |
| **MongoDB** | All session data | Application database | Contract performance |

---

## 2. Legal Basis (GDPR Art. 6)

| Processing activity | Legal basis | GDPR Article |
|---------------------|-------------|--------------|
| Chat conversation | **Consent** (customer initiates chat and agrees) | Art. 6(1)(a) |
| Order verification | **Contract performance** (customer's order) | Art. 6(1)(b) |
| Ticket creation | **Contract performance** (customer support request) | Art. 6(1)(b) |
| AI response generation | **Legitimate interest** (efficient customer service) | Art. 6(1)(f) |
| Analytics & quality monitoring | **Legitimate interest** (service improvement) | Art. 6(1)(f) |
| Consent logging | **Legal obligation** (GDPR accountability) | Art. 6(1)(c) |

---

## 3. Consent Implementation

### 3.1 Chat Consent Banner (already implemented)

The chat widget shows a consent footer on the home screen:

```
"By continuing you agree to our privacy policy."
```

**Current implementation:**
- Displayed at the bottom of the chat home screen
- Links to the privacy policy URL (configurable in plugin settings)
- Consent is logged to `voltimax_chat_consent_log` table with:
  - Customer email
  - Customer name
  - IP address
  - Timestamp
  - Sales channel ID

### 3.2 Recommended Privacy Policy Text (German)

Add this section to your **Datenschutzerklärung** page:

```
Einsatz des VoltimaxChat Chatbots (Groot)

Auf unserer Website setzen wir einen KI-gestützten Chatbot ("Groot") ein, um 
Ihnen schnell und effizient bei Fragen zu Produkten, Bestellungen und Service-
anfragen zu helfen.

Verarbeitete Daten:
• Name und E-Mail-Adresse (von Ihnen eingegeben)
• Chatnachrichten und Gesprächsverlauf
• Bestellnummer und Postleitzahl (bei Bestellverifikation)
• IP-Adresse (für die Einwilligungsdokumentation)
• Hochgeladene Dateien (z.B. Batteriepfand-Formulare)

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
Ihre Nachrichten werden zur Verarbeitung an diese Dienste übermittelt. Die 
Anbieter verarbeiten die Daten gemäß ihren Datenschutzrichtlinien und im Rahmen 
von Standardvertragsklauseln (SCCs) für die Datenübermittlung in Drittländer.

Für die Qualitätsüberwachung nutzen wir LangSmith (LangChain Inc.). Chat-
verläufe werden anonymisiert gespeichert, um die Antwortqualität zu verbessern.

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

### 3.3 Recommended Privacy Policy Text (English)

```
Use of VoltimaxChat Chatbot (Groot)

We use an AI-powered chatbot ("Groot") on our website to assist you quickly 
and efficiently with questions about products, orders, and service requests.

Data processed:
• Name and email address (entered by you)
• Chat messages and conversation history
• Order number and postcode (for order verification)
• IP address (for consent documentation)
• Uploaded files (e.g. battery deposit forms)

Purpose of processing:
• Answering your enquiries using AI-powered text generation
• Order tracking and verification
• Creating support tickets via Zendesk
• Improving our customer service quality

Legal basis:
Processing is based on your consent (Art. 6(1)(a) GDPR), which you provide 
by using the chatbot, and for contract performance (Art. 6(1)(b) GDPR) for 
order-related enquiries.

Third-party providers:
For AI text generation, we use services from Anthropic (Claude) and OpenAI. 
Your messages are transmitted to these services for processing. These providers 
process data in accordance with their privacy policies and under Standard 
Contractual Clauses (SCCs) for data transfers to third countries.

For quality monitoring, we use LangSmith (LangChain Inc.). Chat histories are 
stored anonymously to improve response quality.

Support tickets are created with Zendesk (Zendesk Inc.) when an escalation to 
our support team occurs.

Retention period:
Chat histories are automatically deleted 90 days after session end. Consent 
logs are retained for 3 years in accordance with legal requirements.

Your rights:
You have the right to access, rectification, erasure, restriction of processing, 
data portability, and objection. To exercise your rights, contact us at: 
info@voltimax.de

You can close the chat at any time to stop data processing.
```

---

## 4. Cookie Consent Banner Integration

### 4.1 What VoltimaxChat Uses (NOT Cookies)

VoltimaxChat does **not** set any HTTP cookies. It uses:
- `localStorage` — for remembering returning users (24h)
- `sessionStorage` — for preserving chat across page navigation (tab only)

Under the ePrivacy Directive (and German TTDSG § 25), `localStorage` and `sessionStorage` are treated the same as cookies — they require consent if not strictly necessary.

### 4.2 Classification

| Storage | Strictly necessary? | Consent required? |
|---------|--------------------|--------------------|
| `sessionStorage` (chat state) | **Yes** — required for the chat to function across pages | **No** — exempt under TTDSG § 25 Abs. 2 Nr. 2 |
| `localStorage` (returning user) | **No** — convenience feature | **Yes** — requires consent |

### 4.3 Shopware Cookie Consent Integration

Add VoltimaxChat to your Shopware cookie consent configuration. In your cookie consent manager (e.g. Consentmanager, Cookiebot, or Shopware's built-in cookie consent):

**Cookie/Storage entry:**

```
Name:        VoltimaxChat
Category:    Functional / Komfort
Provider:    Voltimax (First Party)
Purpose:     KI-Chatbot für Kundenservice. Speichert Name und E-Mail für 
             wiederkehrende Besucher (24 Stunden) und Chat-Sitzungsdaten 
             für die Navigation zwischen Seiten.
Storage:     localStorage (voltimax_chat_user, voltimax_chat_id)
             sessionStorage (voltimax_chat_session)
Duration:    localStorage: 24 hours / sessionStorage: browser session
Privacy URL: https://voltimax.de/datenschutz
```

### 4.4 Conditional Loading Based on Consent

If you want the chat widget to only load after cookie consent is given, add this to your Shopware theme or plugin:

```javascript
// Only initialize VoltimaxChat after consent is given
// Example with Shopware's cookie consent:
document.addEventListener('CookieConfiguration_Update', function(event) {
    if (event.detail && event.detail.voltimax_chat) {
        // User consented — initialize the widget
        window.PluginManager.initializePlugin('VoltimaxChatPlugin', '[data-voltimax-chat]');
    }
});
```

Or with Consentmanager/Cookiebot:
```javascript
// Cookiebot example
window.addEventListener('CookiebotOnAccept', function() {
    if (Cookiebot.consent.preferences) {
        window.PluginManager.initializePlugin('VoltimaxChatPlugin', '[data-voltimax-chat]');
    }
});
```

---

## 5. Data Subject Rights (DSAR) Checklist

When a customer requests their data or deletion:

### Right of Access (Art. 15)
- [ ] Export chat sessions from MongoDB: `db.chat_sessions.find({customer_email: "..."})`
- [ ] Export chat messages: `db.chat_messages.find({session_id: {$in: [session_ids]}})`
- [ ] Export consent log: `SELECT * FROM voltimax_chat_consent_log WHERE customer_email = '...'`
- [ ] Check Zendesk for tickets created by email
- [ ] Check LangSmith for traces (search by customer_email metadata)

### Right to Erasure (Art. 17)
- [ ] Delete from MongoDB: sessions, messages, analytics events
- [ ] Delete from Shopware: `voltimax_chat_consent_log`
- [ ] Delete from Zendesk: close/delete tickets (if applicable)
- [ ] Delete from LangSmith: remove traces (if identifiable)
- [ ] Clear any cached data: `POST /cache/clear`

### Automated Deletion
The AI service auto-purges old sessions after the configured retention period (default: 90 days). This runs daily via the background `_daily_purge` task.

---

## 6. Data Processing Agreements (DPAs)

Ensure you have DPAs in place with:

| Provider | Purpose | DPA Link |
|----------|---------|----------|
| **Anthropic** | AI response generation | https://www.anthropic.com/policies/privacy |
| **OpenAI** | Text embeddings for RAG | https://openai.com/policies/data-processing-addendum |
| **LangChain (LangSmith)** | AI tracing & monitoring | https://www.langchain.com/legal |
| **Zendesk** | Support ticket management | https://www.zendesk.com/company/data-processing-form/ |
| **Hetzner** | Server hosting (MongoDB data) | https://www.hetzner.com/legal/privacy-policy |
| **MongoDB Atlas** (if used) | Cloud database | https://www.mongodb.com/legal/dpa |

---

## 7. Summary for Plugin Configuration

In **Shopware Admin → Extensions → VoltimaxChat → Configure**:

| Setting | Recommended Value |
|---------|-------------------|
| `consentText` | "Durch die Nutzung des Chats stimmen Sie unserer Datenschutzerklärung zu." |
| `privacyPolicyUrl` | `https://voltimax.de/datenschutz` |
| `consentCheckboxLabel` | "Ich stimme der Verarbeitung meiner Daten zu" |

---

## 8. Technical Measures (Art. 32)

| Measure | Implementation |
|---------|----------------|
| Encryption in transit | HTTPS/WSS via Let's Encrypt SSL |
| Encryption at rest | MongoDB data on Hetzner encrypted storage |
| Access control | JWT authentication, API key validation |
| Rate limiting | Per-session and per-minute limits |
| Data minimisation | Only name + email collected, no unnecessary fields |
| Pseudonymisation | Chat IDs are random hashes, not PII |
| Retention limits | Auto-purge after 90 days |
| Consent logging | IP + timestamp + email stored in Shopware DB |
| Right to erasure | MongoDB deletion scripts available |
| Audit trail | LangSmith traces, session events, analytics events |
