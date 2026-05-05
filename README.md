# VoltimaxChat — Shopware 6 Plugin

AI-powered customer support chat widget for Shopware 6 storefronts. Connects to the VoltimaxChat AI Service (Server B) for real-time chat with Groot, the AI assistant.

## Features

- **Chat widget** embedded in the storefront with Groot branding (avatar, name, typing animation)
- **WebSocket connection** to AI Service with auto-reconnect
- **JWT authentication** — secure token issued per customer session
- **Dynamic card system** — product cards, order cards, ticket forms, Batteriepfand forms all rendered inside AI message bubbles
- **File upload** — Batteriepfand PDF upload with Zendesk ticket creation
- **Vehicle compatibility check** — cascading dropdowns via OncoCompatibilityFilter
- **Smart suggestions** — context-aware chips above the input field
- **Input locking** — prevents message queuing during AI processing
- **Idle timeout** — session close after inactivity with "Start new chat" option
- **Rating collection** — star ratings on chat close (both X button and Groot-initiated)
- **Session close card** — end-of-conversation flow with review prompt
- **Order verification** — order number + postcode validation via Shopware API
- **Data providers** — orders, products, customers, CMS content served to AI Service
- **Dark mode** support
- **GDPR consent** banner before chat starts

## Requirements

- Shopware 6.6.10+
- PHP 8.1+
- VoltimaxChat AI Service running (Server B)

## Installation

```bash
# Via composer (recommended)
composer require voltimax/chat

# Or copy to custom/plugins/
cp -r voltimax-chat /path/to/shopware/custom/plugins/

# Install and activate
bin/console plugin:refresh
bin/console plugin:install VoltimaxChat
bin/console plugin:activate VoltimaxChat

# Build storefront
bin/build-storefront.sh
```

## Configuration

Go to **Shopware Admin** → **Extensions** → **VoltimaxChat** → **Configure**:

| Setting | Description |
|---------|-------------|
| **Server B URL** | AI Service URL (e.g. `https://chat.voltimax.de`) |
| **JWT Secret** | Shared secret (must match AI Service config) |
| **API Key** | Shared API key for Server A ↔ B communication |
| **Sales Channel** | Which sales channel to enable the widget on |
| **Enabled** | Toggle the chat widget on/off |

## Architecture

```
Storefront (Browser)          Shopware (Server A)           AI Service (Server B)
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ voltimax-chat.js │────────►│ JWT Token Issue  │         │ WebSocket Server │
│ (widget plugin)  │         │ Data Providers   │◄───────►│ AI Pipeline      │
│                  │─────────────────────────────────────►│ (Groot)          │
│ CSS/SCSS styles  │    WebSocket (wss://)                │                  │
└──────────────────┘                                      └──────────────────┘
```

## File Structure

```
src/
├── Config/PluginConfig.php           # Plugin configuration
├── Controller/
│   ├── Api/
│   │   ├── DataProviderController.php  # Order/product/CMS data API
│   │   └── VerificationController.php  # Order verification
│   └── Storefront/
│       └── ChatWidgetController.php    # Widget initialization
├── Security/
│   ├── ApiKeyAuthenticator.php        # API key validation
│   └── RateLimitMiddleware.php        # Rate limiting
├── Service/
│   ├── JwtTokenService.php            # JWT token generation
│   ├── OrderDataService.php           # Order data provider
│   ├── ProductDataService.php         # Product data with properties
│   ├── CustomerDataService.php        # Customer account data
│   ├── CmsDataService.php             # CMS page content sync
│   ├── B2bDataService.php             # B2B quotes/employees
│   └── RateLimiterService.php         # Request rate limiting
├── Resources/
│   ├── config/
│   │   ├── config.xml                 # Plugin admin config fields
│   │   └── services.xml               # Service container definitions
│   └── app/storefront/src/
│       ├── voltimax-chat/
│       │   └── voltimax-chat.plugin.js  # Main widget JavaScript
│       └── scss/                        # Widget styles
└── VoltimaxChat.php                     # Plugin bootstrap
```

## License

Proprietary - Meet Joshi
