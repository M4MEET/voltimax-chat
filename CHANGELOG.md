# Changelog

> **Release rule:** every release section MUST declare its minimum compatible
> backend directly under the version heading, in the form
> `**Backend:** requires voltimax-ai-service >= vX.Y.Z`.
> The backend version refers to a git tag of the `voltimax-ai-service`
> repository (also reported by its `/health` endpoint). CI enforces this for
> all versions after 2.9.1.

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
