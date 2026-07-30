# Changelog

> **Release rule:** every release section MUST declare its minimum compatible
> backend directly under the version heading, in the form
> `**Backend:** requires voltimax-ai-service >= vX.Y.Z`.
> The backend version refers to a git tag of the `voltimax-ai-service`
> repository (also reported by its `/health` endpoint). CI enforces this for
> all versions after 2.9.1.

## 2.14.1

**Backend:** requires voltimax-ai-service >= v1.3.0

### Fixed
- The orange launcher color from 2.14.0 was overridden by the GrootDesk
  pill's animated drift gradient (built from the amber primary) — the
  drift gradient itself now uses the launcher orange, so the "Chat mit
  uns" pill actually shows orange with the shimmer animation intact.

## 2.14.0

**Backend:** requires voltimax-ai-service >= v1.3.0

### Added
- Agent picture above the chat button (plugin config: "Agent-Bild anzeigen"
  toggle + media selector). Shown on desktop and tablet only; landscape
  uploads are center-cropped into a portrait frame; the "Hast du eine
  Frage?" teaser moves to the left of the picture. Clicking the picture
  opens the chat.

### Fixed
- Batteriepfand upload (PDF-only, now clearly communicated): upfront hint
  "Nur PDF · max. 20 MB · eine Datei pro Übermittlung" with a phone-scan
  tip; picking or dropping a non-PDF shows an instant warning ("Wir
  akzeptieren nur PDF-Dateien — bitte versuche es erneut mit einer PDF")
  instead of failing silently — previously the .pdf picker filter left
  mobile customers stuck with no explanation (#7617F16E), and drag & drop
  bypassed the filter entirely. Success screen invites submitting further
  Nachweise (one PDF per submission, #1496F6FB).

## 2.13.0

**Backend:** requires voltimax-ai-service >= v1.3.0

### Fixed
- Mobile: clicking a product link in the chat now collapses the widget to
  the bubble (and the product page opens with the chat collapsed too) — it
  no longer covers the whole page until manually closed (#074FE50B).
- Mobile: the conversation (incl. BatteryFinder results and product cards)
  no longer disappears after navigating to a product. The widget now saves
  its state on `visibilitychange`/`pagehide` (the events phones actually
  fire — `beforeunload` is unreliable there), on clicks of `target="_blank"`
  product links (previously excluded), and continuously within 0.5 s of
  every new message or card.

### Changed
- BatteryFinder: after submitting, the tall select-form collapses into a
  compact "Deine Fahrzeug-Suche: <Fahrzeug>" summary card directly above
  the results, with an "Anderes Fahrzeug prüfen" button for a fresh search.
  A restored conversation shows the summary, never an empty form.

## 2.12.0

**Backend:** requires voltimax-ai-service >= v1.3.0

### Changed
- Purchase-attribution window extended from 30 minutes to 24 hours: the
  `groot_attribution` cookie (set on product clicks in the chat and on
  arrival via `groot_ref` links) and the checkout-finish staleness check
  now both use 24 h. Battery buyers compare prices and come back — a
  30-minute window missed most chat-influenced purchases.
- Pairs with backend GrootBot affiliate links: all product URLs handed out
  by Groot now carry `affiliateCode=GrootBot`, which Shopware natively
  persists onto the order — attribution visible directly in the admin
  order list, independent of any cookie.

## 2.11.3

**Backend:** requires voltimax-ai-service >= v1.3.0

### Fixed
- Support-ticket confirmation form: the e-mail field now validates its
  format client-side (red border + German hint) and shows a concrete
  placeholder (name@beispiel.de) — an order number typed into the field
  previously reached Zendesk and failed with an unexplained generic error
  (prod chat #93BBFF71).
- Submitting a form over a dead connection no longer shows an eternal
  "Wird gesendet …" spinner: the widget refuses upfront with a clear
  reconnect hint, and ticket submissions that get no server confirmation
  within 20 seconds reopen the form honestly instead of hanging.

## 2.11.2

**Backend:** requires voltimax-ai-service >= v1.3.0

### Fixed
- Batteriepfand upload: files over the server limit failed with a generic
  "Upload fehlgeschlagen — bitte erneut versuchen", inviting retries that
  could never succeed (prod chat #D4D0E5D4; the proxy returned an HTML 413
  the widget couldn't parse). Now: a client-side size check rejects files
  over 20 MB instantly with a specific message, and 413 / non-JSON server
  responses show what actually happened plus the info@voltimax.de fallback.

## 2.11.1

**Backend:** requires voltimax-ai-service >= v1.3.0

### Added
- The order API now includes the payment method of the latest transaction
  (`paymentMethod`). The chat's payment status card shows it as a
  "Zahlungsart" row, and Groot can answer "womit habe ich bezahlt?" from
  the verified order's data.

## 2.11.0

**Backend:** requires voltimax-ai-service >= v1.3.0

### Added
- Closed-session state: after an idle timeout the chat locks visibly
  (disabled input "Sitzung beendet", dimmed send orb) and shows a
  GrootDesk-styled banner with **Weiterführen** and **Neuen Chat starten**.
- Weiterführen resumes the same session with full AI context — directly over
  the open connection, or via reconnect after a live idle close. The resume
  window is enforced by the backend (default 30 minutes).
- After the resume window only "Neuen Chat starten" remains; the stale
  transcript is locked for good (`session_expired`).

### Fixed
- The idle-close handler still used a pre-redesign input selector, so the
  chat looked fully open after the session ended: messages typed there were
  silently lost, and a page reload resurrected the closed session
  (prod session #5FFFED47). Stray unlock timers and Enter presses can no
  longer reopen a closed chat.

## 2.10.0

**Backend:** requires voltimax-ai-service >= v1.2.0

### Changed
- Complete "GrootDesk" widget redesign: calm white card, light amber brand
  accents, hairline borders, unified 14px card radii, borderless soft chips,
  pill inputs, ghost send controls, editorial home screen ("Beliebte Themen").
- Info cards match the GrootDesk design language: status rows become soft
  colored header badges (value-derived — real data included), label/value rows
  with hairline separators, white surfaces (no tinted cards or colored blocks).
- All card actions on one system: warm-ink primary buttons, neutral secondary
  pills, soft red danger; gradients and indigo leftovers removed.
- Verification/search/confirmation forms: rounded pill fields, warm focus
  rings, compact right-aligned submits.
- Header island reads the configured widget title (default now
  "GrootDesk Support"); color defaults moved to light amber (#D99A4E).

### Added
- Oracle orb thinking indicator (Siri-style plasma globe): flies out of the
  amber send orb, thinks centered in place of the input field until the
  response is fully generated, then hands the composer back.
- Verification progress card with green "Erfolgreich verifiziert" success
  animation on order/ticket lookups.
- Launcher upgrades: labeled gradient pill with animated color drift, typing
  dots in the icon, idle bounce/shake loop, one-time attention jump with a
  soft chime (autoplay-safe), teaser positioned above the launcher.
- WhatsApp-style delivery meta: time and checkmarks side by side, navy when
  sent/delivered, double green check + "Gelesen" once read.
- Release gate: CHANGELOG must declare the minimum compatible backend
  version (enforced by CI from this release onward).

### Removed
- Groot mascot imagery (professional monogram/wordmark instead; branding now
  lives in the header only).
- Dark mode temporarily disabled: the old dark palette predates this redesign
  and clashes with it. The admin option remains but is inert; a matching dark
  theme returns in 2.11.

## 1.0.0

### Added
- Chat widget with floating bubble on storefront
- GDPR consent screen with configurable text and privacy policy link
- Customer verification form (name, email, optional order number)
- JWT token issuance for Server B authentication
- REST API endpoints for Server B data access (customer, orders, products, CMS, B2B)
- API key authentication for Server B requests
- IP-based rate limiting
- Full admin configuration (general, appearance, consent, verification, API scope, sounds, escalation, rate limiting)
- WebSocket primary / SSE fallback connection to Server B
- Topic cards with conditional visibility
- Dark mode support (light, dark, auto)
- Responsive design (full-width mobile, fixed desktop)
- German and English translations
- Consent logging to database
