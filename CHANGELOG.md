# Changelog

> **Release rule:** every release section MUST declare its minimum compatible
> backend directly under the version heading, in the form
> `**Backend:** requires voltimax-ai-service >= vX.Y.Z`.
> The backend version refers to a git tag of the `voltimax-ai-service`
> repository (also reported by its `/health` endpoint). CI enforces this for
> all versions after 2.9.1.

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
