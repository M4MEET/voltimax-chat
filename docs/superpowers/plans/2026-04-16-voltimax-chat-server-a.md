# VoltimaxChat Shopware Plugin (Server A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Shopware 6 plugin (Server A) that provides: widget injection, GDPR consent + verification flow, JWT auth, Shopware data API for Server B, admin config, rate limiting, and the storefront chat widget frontend.

**Architecture:** Server A is a standard Shopware 6 platform plugin. It exposes REST endpoints authenticated by API key (for Server B) and storefront endpoints for the widget. The storefront JS is a Shopware plugin that manages the chat widget lifecycle (consent, verify, topics, chat). Admin uses Shopware config.xml for settings. JWT tokens bridge Server A verification with Server B WebSocket auth.

**Tech Stack:** PHP 8.1+ / Symfony, Shopware 6.6 DAL, Shopware Storefront JS Plugin System, SCSS, Shopware Admin config.xml

**Spec reference:** `/Users/demon/voltimax-chat/docs/superpowers/specs/2026-04-16-voltimax-chat-design.md`

---

## File Structure

```
voltimax-chat/
├── composer.json
├── CHANGELOG.md
├── src/
│   ├── VoltimaxChat.php                          # Plugin bootstrap
│   ├── Config/
│   │   └── PluginConfig.php                      # Typed config access helper
│   ├── Controller/
│   │   ├── Api/
│   │   │   ├── DataProviderController.php        # REST endpoints for Server B
│   │   │   └── VerificationController.php        # Consent + verification + JWT
│   │   └── Storefront/
│   │       └── ChatWidgetController.php          # Widget config endpoint
│   ├── Service/
│   │   ├── CustomerDataService.php               # Customer info
│   │   ├── OrderDataService.php                  # Orders, tracking
│   │   ├── ProductDataService.php                # Product details, stock
│   │   ├── B2bDataService.php                    # B2B quotes, employees
│   │   ├── CmsDataService.php                    # CMS pages, categories
│   │   ├── JwtTokenService.php                   # JWT generation/validation
│   │   └── RateLimiterService.php                # Per-IP rate limiting
│   ├── Security/
│   │   ├── ApiKeyAuthenticator.php               # Validates Server B API key
│   │   └── RateLimitMiddleware.php               # Throttle middleware
│   ├── Migration/
│   │   └── Migration1713225600CreateConsentLog.php
│   └── Resources/
│       ├── config/
│       │   ├── config.xml                        # Admin configuration
│       │   ├── services.xml                      # Symfony DI
│       │   └── routes.xml                        # API + storefront routes
│       ├── snippet/
│       │   ├── de_DE/
│       │   │   └── voltimax-chat.de-DE.json
│       │   └── en_GB/
│       │       └── voltimax-chat.en-GB.json
│       ├── app/
│       │   └── storefront/
│       │       └── src/
│       │           ├── main.js                   # Shopware plugin registration
│       │           ├── voltimax-chat/
│       │           │   └── voltimax-chat.plugin.js
│       │           └── scss/
│       │               ├── voltimax-chat.scss
│       │               ├── _variables.scss
│       │               ├── _widget.scss
│       │               ├── _messages.scss
│       │               ├── _cards.scss
│       │               ├── _consent.scss
│       │               ├── _dark-mode.scss
│       │               └── _animations.scss
│       └── views/
│           └── storefront/
│               └── layout/
│                   └── base.html.twig            # Widget injection
├── tests/
│   ├── Unit/
│   │   ├── Service/
│   │   │   ├── JwtTokenServiceTest.php
│   │   │   └── RateLimiterServiceTest.php
│   │   ├── Security/
│   │   │   └── ApiKeyAuthenticatorTest.php
│   │   └── Config/
│   │       └── PluginConfigTest.php
│   └── bootstrap.php
└── phpunit.xml
```

---

## Phase 1: Plugin Foundation

### Task 1: Plugin Skeleton

**Files:**
- Create: `composer.json`
- Create: `src/VoltimaxChat.php`
- Create: `src/Resources/config/services.xml`
- Create: `src/Resources/config/routes.xml`

- [ ] **Step 1: Create composer.json**

```json
{
    "name": "voltimax/chat",
    "description": "AI-powered chat widget for Shopware 6 storefronts with Server B AI integration",
    "type": "shopware-platform-plugin",
    "license": "MIT",
    "version": "1.0.0",
    "authors": [
        {
            "name": "Meet Joshi",
            "email": "imeetjoshi@gmail.com",
            "role": "Developer"
        }
    ],
    "autoload": {
        "psr-4": {
            "VoltimaxChat\\": "src/"
        }
    },
    "autoload-dev": {
        "psr-4": {
            "VoltimaxChat\\Tests\\": "tests/"
        }
    },
    "require": {
        "shopware/core": "~6.6.0",
        "shopware/storefront": "~6.6.0"
    },
    "extra": {
        "shopware-plugin-class": "VoltimaxChat\\VoltimaxChat",
        "copyright": "(c) Meet Joshi",
        "label": {
            "de-DE": "VoltimaxChat - KI-Chat Widget",
            "en-GB": "VoltimaxChat - AI Chat Widget"
        },
        "description": {
            "de-DE": "KI-gestuetztes Chat-Widget fuer Shopware 6 Storefronts. Beantwortet Kundenanfragen zu Bestellungen, Produkten und mehr mittels KI.",
            "en-GB": "AI-powered chat widget for Shopware 6 storefronts. Handles customer queries about orders, products, and more using AI."
        }
    }
}
```

- [ ] **Step 2: Create main plugin class**

Create `src/VoltimaxChat.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat;

use Shopware\Core\Framework\Plugin;

class VoltimaxChat extends Plugin
{
}
```

- [ ] **Step 3: Create services.xml skeleton**

Create `src/Resources/config/services.xml`:

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<container xmlns="http://symfony.com/schema/dic/services"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xsi:schemaLocation="http://symfony.com/schema/dic/services
                               http://symfony.com/schema/dic/services/services-1.0.xsd">
    <services>
        <defaults autowire="true" autoconfigure="true"/>

        <!-- Logger -->
        <service id="monolog.logger.voltimax_chat" class="Monolog\Logger">
            <argument>voltimax_chat</argument>
            <tag name="monolog.logger" channel="voltimax_chat"/>
        </service>

    </services>
</container>
```

- [ ] **Step 4: Create routes.xml**

Create `src/Resources/config/routes.xml`:

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<routes xmlns="http://symfony.com/schema/routing"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://symfony.com/schema/routing
                            https://symfony.com/schema/routing/routing-1.0.xsd">
    <import resource="../../Controller/" type="attribute"/>
</routes>
```

- [ ] **Step 5: Install and activate the plugin**

```bash
docker exec -it shopware-6.6.10.8 php bin/console plugin:refresh
docker exec -it shopware-6.6.10.8 php bin/console plugin:install VoltimaxChat --activate
docker exec -it shopware-6.6.10.8 php bin/console cache:clear
```

Expected: Plugin installed and activated without errors.

- [ ] **Step 6: Commit**

```bash
git add composer.json src/VoltimaxChat.php src/Resources/config/services.xml src/Resources/config/routes.xml
git commit -m "feat(server-a): plugin skeleton with bootstrap, services, and routes"
```

---

### Task 2: Plugin Configuration (config.xml)

**Files:**
- Create: `src/Resources/config/config.xml`

- [ ] **Step 1: Create config.xml with all sections**

Create `src/Resources/config/config.xml`:

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="https://raw.githubusercontent.com/shopware/platform/trunk/src/Core/System/SystemConfig/Schema/config.xsd">

    <!-- General Settings -->
    <card>
        <title>General</title>
        <title lang="de-DE">Allgemein</title>

        <input-field type="bool">
            <name>enabled</name>
            <label>Enable Chat Widget</label>
            <label lang="de-DE">Chat-Widget aktivieren</label>
            <defaultValue>false</defaultValue>
        </input-field>

        <input-field type="single-select">
            <name>widgetPosition</name>
            <label>Widget Position</label>
            <label lang="de-DE">Widget-Position</label>
            <defaultValue>bottom-right</defaultValue>
            <options>
                <option>
                    <id>bottom-right</id>
                    <name>Bottom Right</name>
                    <name lang="de-DE">Unten rechts</name>
                </option>
                <option>
                    <id>bottom-left</id>
                    <name>Bottom Left</name>
                    <name lang="de-DE">Unten links</name>
                </option>
            </options>
        </input-field>
    </card>

    <!-- Server B Connection -->
    <card>
        <title>Server B Connection</title>
        <title lang="de-DE">Server B Verbindung</title>

        <input-field type="url">
            <name>serverBUrl</name>
            <label>Server B URL</label>
            <helpText>The URL of the AI service (e.g. https://ai.yourshop.com)</helpText>
        </input-field>

        <input-field type="password">
            <name>apiKey</name>
            <label>Shared API Key</label>
            <label lang="de-DE">Gemeinsamer API-Schluessel</label>
            <helpText>Shared secret used by Server B to authenticate data requests</helpText>
        </input-field>

        <input-field type="password">
            <name>jwtSecret</name>
            <label>JWT Secret</label>
            <helpText>Secret key for signing JWT tokens (min 32 characters)</helpText>
        </input-field>

        <input-field type="int">
            <name>jwtTtlMinutes</name>
            <label>JWT Token Lifetime (minutes)</label>
            <defaultValue>30</defaultValue>
        </input-field>
    </card>

    <!-- Appearance -->
    <card>
        <title>Appearance</title>
        <title lang="de-DE">Erscheinungsbild</title>

        <input-field type="colorpicker">
            <name>primaryColor</name>
            <label>Primary Color</label>
            <defaultValue>#4F46E5</defaultValue>
        </input-field>

        <component name="sw-media-field">
            <name>logoMediaId</name>
            <label>Chat Logo / Avatar</label>
        </component>

        <input-field type="text">
            <name>widgetTitle</name>
            <label>Widget Title</label>
            <defaultValue>Chat Support</defaultValue>
        </input-field>

        <input-field type="textarea">
            <name>welcomeMessage</name>
            <label>Welcome Message</label>
            <defaultValue>Hallo! Wie kann ich Ihnen helfen?</defaultValue>
        </input-field>

        <input-field type="single-select">
            <name>colorMode</name>
            <label>Color Mode</label>
            <defaultValue>light</defaultValue>
            <options>
                <option>
                    <id>light</id>
                    <name>Light</name>
                </option>
                <option>
                    <id>dark</id>
                    <name>Dark</name>
                </option>
                <option>
                    <id>auto</id>
                    <name>Auto (OS preference)</name>
                </option>
            </options>
        </input-field>

        <input-field type="textarea">
            <name>customCss</name>
            <label>Custom CSS Override</label>
        </input-field>
    </card>

    <!-- Consent -->
    <card>
        <title>Consent / GDPR</title>
        <title lang="de-DE">Einwilligung / DSGVO</title>

        <input-field type="textarea">
            <name>consentText</name>
            <label>Consent Text</label>
            <defaultValue>Wir verwenden KI, um Ihre Anfragen zu beantworten. Ihre Daten werden vertraulich behandelt.</defaultValue>
        </input-field>

        <input-field type="url">
            <name>privacyPolicyUrl</name>
            <label>Privacy Policy URL</label>
        </input-field>

        <input-field type="text">
            <name>consentCheckboxLabel</name>
            <label>Consent Checkbox Label</label>
            <defaultValue>Ich stimme der Verarbeitung meiner Daten zu</defaultValue>
        </input-field>
    </card>

    <!-- Verification -->
    <card>
        <title>Verification</title>
        <title lang="de-DE">Verifizierung</title>

        <input-field type="bool">
            <name>requireOrderNumber</name>
            <label>Require Order Number</label>
            <defaultValue>false</defaultValue>
            <helpText>If disabled, order number is optional but improves AI context when provided</helpText>
        </input-field>

        <input-field type="bool">
            <name>strictValidation</name>
            <label>Strict Validation</label>
            <defaultValue>false</defaultValue>
            <helpText>If enabled, email must match an existing customer</helpText>
        </input-field>
    </card>

    <!-- Shopware API Scope -->
    <card>
        <title>Shopware API Scope</title>

        <input-field type="bool">
            <name>scopeOrders</name>
            <label>Orders</label>
            <defaultValue>true</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>scopeProducts</name>
            <label>Products</label>
            <defaultValue>true</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>scopeCustomers</name>
            <label>Customers</label>
            <defaultValue>true</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>scopeReturns</name>
            <label>Returns</label>
            <defaultValue>true</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>scopeB2bQuotes</name>
            <label>B2B Quotes</label>
            <defaultValue>false</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>scopeCms</name>
            <label>CMS Pages</label>
            <defaultValue>true</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>scopeWishlist</name>
            <label>Wishlist</label>
            <defaultValue>false</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>scopePayments</name>
            <label>Payments</label>
            <defaultValue>false</defaultValue>
        </input-field>
    </card>

    <!-- Sounds -->
    <card>
        <title>Sounds</title>

        <input-field type="bool">
            <name>soundIncoming</name>
            <label>Incoming Message Sound</label>
            <defaultValue>true</defaultValue>
        </input-field>

        <input-field type="bool">
            <name>soundOutgoing</name>
            <label>Outgoing Message Sound</label>
            <defaultValue>false</defaultValue>
        </input-field>
    </card>

    <!-- Escalation -->
    <card>
        <title>Escalation</title>

        <input-field type="url">
            <name>contactFormUrl</name>
            <label>Contact Form URL</label>
            <helpText>External URL opened when user requests human support</helpText>
        </input-field>

        <input-field type="bool">
            <name>aiEscalationEnabled</name>
            <label>Enable AI-Driven Escalation</label>
            <defaultValue>true</defaultValue>
        </input-field>
    </card>

    <!-- Rate Limiting -->
    <card>
        <title>Rate Limiting</title>

        <input-field type="int">
            <name>rateLimitPerMinute</name>
            <label>Max Requests per IP per Minute</label>
            <defaultValue>30</defaultValue>
        </input-field>

        <input-field type="int">
            <name>rateLimitVerifyPerMinute</name>
            <label>Max Verification Attempts per IP per Minute</label>
            <defaultValue>5</defaultValue>
        </input-field>
    </card>

</config>
```

- [ ] **Step 2: Clear cache and verify config in admin**

```bash
docker exec -it shopware-6.6.10.8 php bin/console cache:clear
```

Navigate to Admin > Extensions > VoltimaxChat > Config. Verify all cards render.

- [ ] **Step 3: Commit**

```bash
git add src/Resources/config/config.xml
git commit -m "feat(server-a): plugin configuration with all admin settings"
```

---

### Task 3: Database Migration (Consent Log)

**Files:**
- Create: `src/Migration/Migration1713225600CreateConsentLog.php`

- [ ] **Step 1: Create consent log migration**

Create `src/Migration/Migration1713225600CreateConsentLog.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Migration;

use Doctrine\DBAL\Connection;
use Shopware\Core\Framework\Migration\MigrationStep;

class Migration1713225600CreateConsentLog extends MigrationStep
{
    public function getCreationTimestamp(): int
    {
        return 1713225600;
    }

    public function update(Connection $connection): void
    {
        $connection->executeStatement('
            CREATE TABLE IF NOT EXISTS `voltimax_chat_consent_log` (
                `id` BINARY(16) NOT NULL,
                `customer_email` VARCHAR(255) NOT NULL,
                `customer_name` VARCHAR(255) NOT NULL,
                `ip_address` VARCHAR(45) NOT NULL,
                `consented_at` DATETIME(3) NOT NULL,
                `sales_channel_id` BINARY(16) NULL,
                `created_at` DATETIME(3) NOT NULL,
                `updated_at` DATETIME(3) NULL,
                PRIMARY KEY (`id`),
                INDEX `idx_email` (`customer_email`),
                INDEX `idx_consented_at` (`consented_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ');
    }

    public function updateDestructive(Connection $connection): void
    {
    }
}
```

- [ ] **Step 2: Run migration**

```bash
docker exec -it shopware-6.6.10.8 php bin/console database:migrate --all VoltimaxChat
```

- [ ] **Step 3: Verify table exists**

```bash
docker exec -it shopware-6.6.10.8 php bin/console dbal:run-sql "SHOW TABLES LIKE 'voltimax_chat_consent_log'"
```

- [ ] **Step 4: Commit**

```bash
git add src/Migration/
git commit -m "feat(server-a): consent log database migration"
```

---

## Phase 2: Security and Config

### Task 4: PluginConfig Helper

**Files:**
- Create: `src/Config/PluginConfig.php`
- Create: `tests/Unit/Config/PluginConfigTest.php`
- Create: `tests/bootstrap.php`
- Create: `phpunit.xml`

- [ ] **Step 1: Create test bootstrap and phpunit.xml**

Create `tests/bootstrap.php`:

```php
<?php declare(strict_types=1);

require_once __DIR__ . '/../../../vendor/autoload.php';
```

Create `phpunit.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="https://schema.phpunit.de/10.5/phpunit.xsd"
         bootstrap="tests/bootstrap.php"
         colors="true">
    <testsuites>
        <testsuite name="Unit">
            <directory>tests/Unit</directory>
        </testsuite>
    </testsuites>
</phpunit>
```

- [ ] **Step 2: Write PluginConfig test**

Create `tests/Unit/Config/PluginConfigTest.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Tests\Unit\Config;

use PHPUnit\Framework\TestCase;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use VoltimaxChat\Config\PluginConfig;

class PluginConfigTest extends TestCase
{
    public function testIsEnabledReturnsFalseByDefault(): void
    {
        $systemConfig = $this->createMock(SystemConfigService::class);
        $systemConfig->method('get')->with('VoltimaxChat.config.enabled')->willReturn(null);

        $config = new PluginConfig($systemConfig);
        static::assertFalse($config->isEnabled());
    }

    public function testGetServerBUrlReturnsConfiguredUrl(): void
    {
        $systemConfig = $this->createMock(SystemConfigService::class);
        $systemConfig->method('get')
            ->willReturnMap([['VoltimaxChat.config.serverBUrl', null, 'https://ai.example.com']]);

        $config = new PluginConfig($systemConfig);
        static::assertSame('https://ai.example.com', $config->getServerBUrl());
    }

    public function testIsScopeEnabledChecksCorrectKey(): void
    {
        $systemConfig = $this->createMock(SystemConfigService::class);
        $systemConfig->method('get')->willReturnMap([
            ['VoltimaxChat.config.scopeOrders', null, true],
            ['VoltimaxChat.config.scopeB2bQuotes', null, false],
        ]);

        $config = new PluginConfig($systemConfig);
        static::assertTrue($config->isScopeEnabled('orders'));
        static::assertFalse($config->isScopeEnabled('b2bQuotes'));
    }

    public function testGetJwtTtlReturnsSecondsFromMinutes(): void
    {
        $systemConfig = $this->createMock(SystemConfigService::class);
        $systemConfig->method('get')->with('VoltimaxChat.config.jwtTtlMinutes')->willReturn(30);

        $config = new PluginConfig($systemConfig);
        static::assertSame(1800, $config->getJwtTtlSeconds());
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit tests/Unit/Config/PluginConfigTest.php"
```

Expected: FAIL (class PluginConfig not found).

- [ ] **Step 4: Implement PluginConfig**

Create `src/Config/PluginConfig.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Config;

use Shopware\Core\System\SystemConfig\SystemConfigService;

class PluginConfig
{
    private const PREFIX = 'VoltimaxChat.config.';

    private SystemConfigService $systemConfig;

    public function __construct(SystemConfigService $systemConfig)
    {
        $this->systemConfig = $systemConfig;
    }

    public function isEnabled(): bool
    {
        return (bool) $this->get('enabled');
    }

    public function getServerBUrl(): ?string
    {
        return $this->get('serverBUrl');
    }

    public function getApiKey(): ?string
    {
        return $this->get('apiKey');
    }

    public function getJwtSecret(): ?string
    {
        return $this->get('jwtSecret');
    }

    public function getJwtTtlSeconds(): int
    {
        $minutes = (int) ($this->get('jwtTtlMinutes') ?? 30);
        return $minutes * 60;
    }

    public function getPrimaryColor(): string
    {
        return $this->get('primaryColor') ?? '#4F46E5';
    }

    public function getLogoMediaId(): ?string
    {
        return $this->get('logoMediaId');
    }

    public function getWidgetTitle(): string
    {
        return $this->get('widgetTitle') ?? 'Chat Support';
    }

    public function getWelcomeMessage(): string
    {
        return $this->get('welcomeMessage') ?? 'Hallo! Wie kann ich Ihnen helfen?';
    }

    public function getColorMode(): string
    {
        return $this->get('colorMode') ?? 'light';
    }

    public function getCustomCss(): ?string
    {
        return $this->get('customCss');
    }

    public function getWidgetPosition(): string
    {
        return $this->get('widgetPosition') ?? 'bottom-right';
    }

    public function getConsentText(): string
    {
        return $this->get('consentText') ?? '';
    }

    public function getPrivacyPolicyUrl(): ?string
    {
        return $this->get('privacyPolicyUrl');
    }

    public function getConsentCheckboxLabel(): string
    {
        return $this->get('consentCheckboxLabel') ?? '';
    }

    public function isOrderNumberRequired(): bool
    {
        return (bool) $this->get('requireOrderNumber');
    }

    public function isStrictValidation(): bool
    {
        return (bool) $this->get('strictValidation');
    }

    public function isScopeEnabled(string $scope): bool
    {
        $key = 'scope' . ucfirst($scope);
        return (bool) $this->get($key);
    }

    public function isSoundIncomingEnabled(): bool
    {
        return (bool) ($this->get('soundIncoming') ?? true);
    }

    public function isSoundOutgoingEnabled(): bool
    {
        return (bool) $this->get('soundOutgoing');
    }

    public function getContactFormUrl(): ?string
    {
        return $this->get('contactFormUrl');
    }

    public function isAiEscalationEnabled(): bool
    {
        return (bool) ($this->get('aiEscalationEnabled') ?? true);
    }

    public function getRateLimitPerMinute(): int
    {
        return (int) ($this->get('rateLimitPerMinute') ?? 30);
    }

    public function getRateLimitVerifyPerMinute(): int
    {
        return (int) ($this->get('rateLimitVerifyPerMinute') ?? 5);
    }

    /** @return mixed */
    private function get(string $key)
    {
        return $this->systemConfig->get(self::PREFIX . $key);
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit tests/Unit/Config/PluginConfigTest.php -v"
```

Expected: 4 tests, 4 assertions, all PASS.

- [ ] **Step 6: Register service and commit**

Add to `src/Resources/config/services.xml` inside `<services>`:

```xml
        <!-- Config Helper -->
        <service id="VoltimaxChat\Config\PluginConfig">
            <argument type="service" id="Shopware\Core\System\SystemConfig\SystemConfigService"/>
        </service>
```

```bash
git add src/Config/ tests/ phpunit.xml
git commit -m "feat(server-a): typed PluginConfig helper with unit tests"
```

---

### Task 5: JWT Token Service

**Files:**
- Create: `src/Service/JwtTokenService.php`
- Create: `tests/Unit/Service/JwtTokenServiceTest.php`

- [ ] **Step 1: Write JWT test**

Create `tests/Unit/Service/JwtTokenServiceTest.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use VoltimaxChat\Service\JwtTokenService;

class JwtTokenServiceTest extends TestCase
{
    private JwtTokenService $service;

    protected function setUp(): void
    {
        $this->service = new JwtTokenService('test-secret-key-that-is-long-enough', 1800);
    }

    public function testCreateReturnsThreePartToken(): void
    {
        $token = $this->service->create(['email' => 'test@example.com']);
        $parts = explode('.', $token);
        static::assertCount(3, $parts);
    }

    public function testValidateReturnsPayloadForValidToken(): void
    {
        $token = $this->service->create([
            'email' => 'test@example.com',
            'name' => 'Test User',
        ]);

        $payload = $this->service->validate($token);
        static::assertNotNull($payload);
        static::assertSame('test@example.com', $payload['email']);
        static::assertSame('Test User', $payload['name']);
        static::assertArrayHasKey('iat', $payload);
        static::assertArrayHasKey('exp', $payload);
    }

    public function testValidateReturnsNullForTamperedToken(): void
    {
        $token = $this->service->create(['email' => 'test@example.com']);
        $tampered = $token . 'x';
        static::assertNull($this->service->validate($tampered));
    }

    public function testValidateReturnsNullForExpiredToken(): void
    {
        $service = new JwtTokenService('test-secret-key-that-is-long-enough', -10);
        $token = $service->create(['email' => 'test@example.com']);

        $otherService = new JwtTokenService('test-secret-key-that-is-long-enough', 1800);
        static::assertNull($otherService->validate($token));
    }

    public function testValidateReturnsNullForWrongSecret(): void
    {
        $token = $this->service->create(['email' => 'test@example.com']);
        $otherService = new JwtTokenService('different-secret-key-here-long-enough', 1800);
        static::assertNull($otherService->validate($token));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit tests/Unit/Service/JwtTokenServiceTest.php -v"
```

Expected: FAIL (class JwtTokenService not found).

- [ ] **Step 3: Implement JwtTokenService**

Create `src/Service/JwtTokenService.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Service;

use VoltimaxChat\Config\PluginConfig;

class JwtTokenService
{
    private ?string $secret;
    private ?int $ttlSeconds;
    private ?PluginConfig $config;

    /**
     * Accepts PluginConfig (production) or string secret + int ttl (testing).
     */
    public function __construct($secretOrConfig, ?int $ttlSeconds = null)
    {
        if ($secretOrConfig instanceof PluginConfig) {
            $this->config = $secretOrConfig;
            $this->secret = null;
            $this->ttlSeconds = null;
        } else {
            $this->config = null;
            $this->secret = (string) $secretOrConfig;
            $this->ttlSeconds = $ttlSeconds ?? 1800;
        }
    }

    public function create(array $payload): string
    {
        $header = self::base64UrlEncode(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR));

        $payload['iat'] = time();
        $payload['exp'] = time() + $this->getTtl();
        $payloadEncoded = self::base64UrlEncode(json_encode($payload, JSON_THROW_ON_ERROR));

        $signature = hash_hmac('sha256', "$header.$payloadEncoded", $this->getSecret(), true);
        $signatureEncoded = self::base64UrlEncode($signature);

        return "$header.$payloadEncoded.$signatureEncoded";
    }

    public function validate(string $token): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }

        [$header, $payload, $signature] = $parts;

        $expectedSignature = self::base64UrlEncode(
            hash_hmac('sha256', "$header.$payload", $this->getSecret(), true)
        );

        if (!hash_equals($expectedSignature, $signature)) {
            return null;
        }

        $decoded = json_decode(self::base64UrlDecode($payload), true);
        if (!is_array($decoded)) {
            return null;
        }

        if (isset($decoded['exp']) && $decoded['exp'] < time()) {
            return null;
        }

        return $decoded;
    }

    private function getSecret(): string
    {
        return $this->secret ?? ($this->config ? ($this->config->getJwtSecret() ?? '') : '');
    }

    private function getTtl(): int
    {
        return $this->ttlSeconds ?? ($this->config ? $this->config->getJwtTtlSeconds() : 1800);
    }

    private static function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function base64UrlDecode(string $data): string
    {
        return base64_decode(strtr($data, '-_', '+/'), true) ?: '';
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit tests/Unit/Service/JwtTokenServiceTest.php -v"
```

Expected: 5 tests, all PASS.

- [ ] **Step 5: Register service and commit**

Add to `services.xml`:

```xml
        <!-- JWT Token Service -->
        <service id="VoltimaxChat\Service\JwtTokenService">
            <argument type="service" id="VoltimaxChat\Config\PluginConfig"/>
        </service>
```

```bash
git add src/Service/JwtTokenService.php tests/Unit/Service/JwtTokenServiceTest.php src/Resources/config/services.xml
git commit -m "feat(server-a): JWT token service with HMAC-SHA256 signing"
```

---

### Task 6: API Key Authenticator

**Files:**
- Create: `src/Security/ApiKeyAuthenticator.php`
- Create: `tests/Unit/Security/ApiKeyAuthenticatorTest.php`

- [ ] **Step 1: Write test**

Create `tests/Unit/Security/ApiKeyAuthenticatorTest.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Tests\Unit\Security;

use PHPUnit\Framework\TestCase;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use Symfony\Component\HttpFoundation\Request;
use VoltimaxChat\Config\PluginConfig;
use VoltimaxChat\Security\ApiKeyAuthenticator;

class ApiKeyAuthenticatorTest extends TestCase
{
    private ApiKeyAuthenticator $auth;

    protected function setUp(): void
    {
        $systemConfig = $this->createMock(SystemConfigService::class);
        $systemConfig->method('get')
            ->willReturnMap([['VoltimaxChat.config.apiKey', null, 'my-secret-api-key']]);

        $this->auth = new ApiKeyAuthenticator(new PluginConfig($systemConfig));
    }

    public function testValidApiKeyInHeader(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'my-secret-api-key');
        static::assertTrue($this->auth->authenticate($request));
    }

    public function testInvalidApiKeyReturnsFalse(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'wrong-key');
        static::assertFalse($this->auth->authenticate($request));
    }

    public function testMissingApiKeyReturnsFalse(): void
    {
        $request = new Request();
        static::assertFalse($this->auth->authenticate($request));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit tests/Unit/Security/ApiKeyAuthenticatorTest.php -v"
```

- [ ] **Step 3: Implement ApiKeyAuthenticator**

Create `src/Security/ApiKeyAuthenticator.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Security;

use Symfony\Component\HttpFoundation\Request;
use VoltimaxChat\Config\PluginConfig;

class ApiKeyAuthenticator
{
    private const HEADER = 'X-Voltimax-Api-Key';

    private PluginConfig $config;

    public function __construct(PluginConfig $config)
    {
        $this->config = $config;
    }

    public function authenticate(Request $request): bool
    {
        $providedKey = $request->headers->get(self::HEADER);
        $configuredKey = $this->config->getApiKey();

        if ($providedKey === null || $configuredKey === null || $configuredKey === '') {
            return false;
        }

        return hash_equals($configuredKey, $providedKey);
    }
}
```

- [ ] **Step 4: Run tests, register service, commit**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit tests/Unit/Security/ApiKeyAuthenticatorTest.php -v"
```

Add to `services.xml`:

```xml
        <!-- Security -->
        <service id="VoltimaxChat\Security\ApiKeyAuthenticator">
            <argument type="service" id="VoltimaxChat\Config\PluginConfig"/>
        </service>
```

```bash
git add src/Security/ApiKeyAuthenticator.php tests/Unit/Security/ src/Resources/config/services.xml
git commit -m "feat(server-a): API key authenticator for Server B requests"
```

---

### Task 7: Rate Limiter Service and Middleware

**Files:**
- Create: `src/Service/RateLimiterService.php`
- Create: `src/Security/RateLimitMiddleware.php`
- Create: `tests/Unit/Service/RateLimiterServiceTest.php`

- [ ] **Step 1: Write rate limiter test**

Create `tests/Unit/Service/RateLimiterServiceTest.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use VoltimaxChat\Service\RateLimiterService;

class RateLimiterServiceTest extends TestCase
{
    public function testAllowsRequestsUnderLimit(): void
    {
        $limiter = new RateLimiterService(new ArrayAdapter());
        static::assertTrue($limiter->isAllowed('127.0.0.1', 'general', 5));
        static::assertTrue($limiter->isAllowed('127.0.0.1', 'general', 5));
    }

    public function testBlocksRequestsOverLimit(): void
    {
        $limiter = new RateLimiterService(new ArrayAdapter());
        for ($i = 0; $i < 3; $i++) {
            $limiter->isAllowed('127.0.0.1', 'test', 3);
        }
        static::assertFalse($limiter->isAllowed('127.0.0.1', 'test', 3));
    }

    public function testDifferentIpsTrackedSeparately(): void
    {
        $limiter = new RateLimiterService(new ArrayAdapter());
        for ($i = 0; $i < 3; $i++) {
            $limiter->isAllowed('10.0.0.1', 'test', 3);
        }
        static::assertFalse($limiter->isAllowed('10.0.0.1', 'test', 3));
        static::assertTrue($limiter->isAllowed('10.0.0.2', 'test', 3));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit tests/Unit/Service/RateLimiterServiceTest.php -v"
```

- [ ] **Step 3: Implement RateLimiterService**

Create `src/Service/RateLimiterService.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Service;

use Psr\Cache\CacheItemPoolInterface;

class RateLimiterService
{
    private CacheItemPoolInterface $cache;

    public function __construct(CacheItemPoolInterface $cache)
    {
        $this->cache = $cache;
    }

    public function isAllowed(string $ip, string $bucket, int $maxPerMinute): bool
    {
        $key = 'voltimax_chat_rl_' . md5($ip . '_' . $bucket);
        $window = (int) (time() / 60);

        $item = $this->cache->getItem($key);
        $data = $item->isHit() ? $item->get() : ['window' => $window, 'count' => 0];

        if ($data['window'] !== $window) {
            $data = ['window' => $window, 'count' => 0];
        }

        $data['count']++;
        $item->set($data);
        $item->expiresAfter(120);
        $this->cache->save($item);

        return $data['count'] <= $maxPerMinute;
    }
}
```

- [ ] **Step 4: Implement RateLimitMiddleware**

Create `src/Security/RateLimitMiddleware.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Security;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use VoltimaxChat\Config\PluginConfig;
use VoltimaxChat\Service\RateLimiterService;

class RateLimitMiddleware
{
    private RateLimiterService $rateLimiter;
    private PluginConfig $config;

    public function __construct(RateLimiterService $rateLimiter, PluginConfig $config)
    {
        $this->rateLimiter = $rateLimiter;
        $this->config = $config;
    }

    public function checkGeneralLimit(Request $request): ?JsonResponse
    {
        $ip = $request->getClientIp() ?? 'unknown';
        if (!$this->rateLimiter->isAllowed($ip, 'general', $this->config->getRateLimitPerMinute())) {
            return new JsonResponse(['error' => 'Rate limit exceeded'], Response::HTTP_TOO_MANY_REQUESTS);
        }
        return null;
    }

    public function checkVerifyLimit(Request $request): ?JsonResponse
    {
        $ip = $request->getClientIp() ?? 'unknown';
        if (!$this->rateLimiter->isAllowed($ip, 'verify', $this->config->getRateLimitVerifyPerMinute())) {
            return new JsonResponse(['error' => 'Too many verification attempts'], Response::HTTP_TOO_MANY_REQUESTS);
        }
        return null;
    }
}
```

- [ ] **Step 5: Run tests, register services, commit**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit -v"
```

Add to `services.xml`:

```xml
        <!-- Rate Limiter -->
        <service id="VoltimaxChat\Service\RateLimiterService">
            <argument type="service" id="cache.object"/>
        </service>

        <service id="VoltimaxChat\Security\RateLimitMiddleware">
            <argument type="service" id="VoltimaxChat\Service\RateLimiterService"/>
            <argument type="service" id="VoltimaxChat\Config\PluginConfig"/>
        </service>
```

```bash
git add src/Service/RateLimiterService.php src/Security/RateLimitMiddleware.php tests/Unit/Service/RateLimiterServiceTest.php src/Resources/config/services.xml
git commit -m "feat(server-a): rate limiter service and middleware"
```

---

## Phase 3: Controllers

### Task 8: Verification Controller

**Files:**
- Create: `src/Controller/Api/VerificationController.php`

- [ ] **Step 1: Implement VerificationController**

Create `src/Controller/Api/VerificationController.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Controller\Api;

use Doctrine\DBAL\Connection;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\Uuid\Uuid;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use VoltimaxChat\Config\PluginConfig;
use VoltimaxChat\Security\RateLimitMiddleware;
use VoltimaxChat\Service\JwtTokenService;

#[Route(defaults: ['_routeScope' => ['storefront']])]
class VerificationController extends AbstractController
{
    private PluginConfig $config;
    private JwtTokenService $jwt;
    private RateLimitMiddleware $rateLimit;
    private EntityRepository $customerRepository;
    private EntityRepository $orderRepository;
    private Connection $connection;

    public function __construct(
        PluginConfig $config,
        JwtTokenService $jwt,
        RateLimitMiddleware $rateLimit,
        EntityRepository $customerRepository,
        EntityRepository $orderRepository,
        Connection $connection
    ) {
        $this->config = $config;
        $this->jwt = $jwt;
        $this->rateLimit = $rateLimit;
        $this->customerRepository = $customerRepository;
        $this->orderRepository = $orderRepository;
        $this->connection = $connection;
    }

    #[Route(path: '/voltimax-chat/consent', name: 'voltimax.chat.consent', methods: ['POST'])]
    public function consent(Request $request): JsonResponse
    {
        if (!$this->config->isEnabled()) {
            return new JsonResponse(['error' => 'Chat disabled'], Response::HTTP_SERVICE_UNAVAILABLE);
        }

        $rateLimitResponse = $this->rateLimit->checkGeneralLimit($request);
        if ($rateLimitResponse !== null) {
            return $rateLimitResponse;
        }

        $data = json_decode($request->getContent(), true);
        $email = trim($data['email'] ?? '');
        $name = trim($data['name'] ?? '');

        if ($email === '' || $name === '') {
            return new JsonResponse(['error' => 'Name and email are required'], Response::HTTP_BAD_REQUEST);
        }

        $now = (new \DateTimeImmutable())->format('Y-m-d H:i:s.v');
        $this->connection->insert('voltimax_chat_consent_log', [
            'id' => Uuid::randomBytes(),
            'customer_email' => $email,
            'customer_name' => $name,
            'ip_address' => $request->getClientIp() ?? 'unknown',
            'consented_at' => $now,
            'created_at' => $now,
        ]);

        return new JsonResponse(['success' => true]);
    }

    #[Route(path: '/voltimax-chat/verify', name: 'voltimax.chat.verify', methods: ['POST'])]
    public function verify(Request $request): JsonResponse
    {
        if (!$this->config->isEnabled()) {
            return new JsonResponse(['error' => 'Chat disabled'], Response::HTTP_SERVICE_UNAVAILABLE);
        }

        $rateLimitResponse = $this->rateLimit->checkVerifyLimit($request);
        if ($rateLimitResponse !== null) {
            return $rateLimitResponse;
        }

        $data = json_decode($request->getContent(), true);
        $email = trim($data['email'] ?? '');
        $name = trim($data['name'] ?? '');
        $orderNumber = trim($data['orderNumber'] ?? '');

        if ($email === '' || $name === '') {
            return new JsonResponse(['error' => 'Name and email are required'], Response::HTTP_BAD_REQUEST);
        }

        if ($this->config->isOrderNumberRequired() && $orderNumber === '') {
            return new JsonResponse(['error' => 'Order number is required'], Response::HTTP_BAD_REQUEST);
        }

        $context = Context::createDefaultContext();
        $customerContext = ['has_orders' => false, 'is_b2b' => false, 'customer_id' => null];

        if ($this->config->isStrictValidation()) {
            $criteria = new Criteria();
            $criteria->addFilter(new EqualsFilter('email', $email));
            $criteria->setLimit(1);
            $customer = $this->customerRepository->search($criteria, $context)->first();

            if ($customer === null) {
                return new JsonResponse(['error' => 'Customer not found'], Response::HTTP_UNPROCESSABLE_ENTITY);
            }
            $customerContext['customer_id'] = $customer->getId();
        }

        if ($orderNumber !== '') {
            $criteria = new Criteria();
            $criteria->addFilter(new EqualsFilter('orderNumber', $orderNumber));
            $criteria->setLimit(1);
            $order = $this->orderRepository->search($criteria, $context)->first();

            if ($order !== null) {
                $customerContext['has_orders'] = true;
            } elseif ($this->config->isStrictValidation()) {
                return new JsonResponse(['error' => 'Order not found'], Response::HTTP_UNPROCESSABLE_ENTITY);
            }
        }

        if (!$customerContext['has_orders'] && $customerContext['customer_id'] !== null) {
            $criteria = new Criteria();
            $criteria->addFilter(new EqualsFilter('orderCustomer.customerId', $customerContext['customer_id']));
            $criteria->setLimit(1);
            $customerContext['has_orders'] = $this->orderRepository->search($criteria, $context)->getTotal() > 0;
        }

        $token = $this->jwt->create([
            'email' => $email,
            'name' => $name,
            'customer_id' => $customerContext['customer_id'],
            'has_orders' => $customerContext['has_orders'],
            'is_b2b' => $customerContext['is_b2b'],
        ]);

        return new JsonResponse(['token' => $token, 'context' => $customerContext]);
    }
}
```

- [ ] **Step 2: Register controller and commit**

Add to `services.xml`:

```xml
        <!-- Controllers -->
        <service id="VoltimaxChat\Controller\Api\VerificationController" public="true">
            <argument type="service" id="VoltimaxChat\Config\PluginConfig"/>
            <argument type="service" id="VoltimaxChat\Service\JwtTokenService"/>
            <argument type="service" id="VoltimaxChat\Security\RateLimitMiddleware"/>
            <argument type="service" id="customer.repository"/>
            <argument type="service" id="order.repository"/>
            <argument type="service" id="Doctrine\DBAL\Connection"/>
        </service>
```

```bash
docker exec -it shopware-6.6.10.8 php bin/console cache:clear
docker exec -it shopware-6.6.10.8 php bin/console router:match /voltimax-chat/verify --method=POST
git add src/Controller/Api/VerificationController.php src/Resources/config/services.xml
git commit -m "feat(server-a): verification controller with consent, validation, JWT"
```

---

### Task 9: Widget Config Controller

**Files:**
- Create: `src/Controller/Storefront/ChatWidgetController.php`

- [ ] **Step 1: Implement ChatWidgetController**

Create `src/Controller/Storefront/ChatWidgetController.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Controller\Storefront;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use VoltimaxChat\Config\PluginConfig;
use VoltimaxChat\Security\RateLimitMiddleware;

#[Route(defaults: ['_routeScope' => ['storefront']])]
class ChatWidgetController extends AbstractController
{
    private PluginConfig $config;
    private RateLimitMiddleware $rateLimit;

    public function __construct(PluginConfig $config, RateLimitMiddleware $rateLimit)
    {
        $this->config = $config;
        $this->rateLimit = $rateLimit;
    }

    #[Route(path: '/voltimax-chat/config', name: 'voltimax.chat.config', methods: ['GET'])]
    public function config(Request $request): JsonResponse
    {
        $rateLimitResponse = $this->rateLimit->checkGeneralLimit($request);
        if ($rateLimitResponse !== null) {
            return $rateLimitResponse;
        }

        if (!$this->config->isEnabled()) {
            return new JsonResponse(['enabled' => false]);
        }

        return new JsonResponse([
            'enabled' => true,
            'serverBUrl' => $this->config->getServerBUrl(),
            'widgetPosition' => $this->config->getWidgetPosition(),
            'primaryColor' => $this->config->getPrimaryColor(),
            'widgetTitle' => $this->config->getWidgetTitle(),
            'welcomeMessage' => $this->config->getWelcomeMessage(),
            'colorMode' => $this->config->getColorMode(),
            'customCss' => $this->config->getCustomCss(),
            'consentText' => $this->config->getConsentText(),
            'privacyPolicyUrl' => $this->config->getPrivacyPolicyUrl(),
            'consentCheckboxLabel' => $this->config->getConsentCheckboxLabel(),
            'requireOrderNumber' => $this->config->isOrderNumberRequired(),
            'soundIncoming' => $this->config->isSoundIncomingEnabled(),
            'soundOutgoing' => $this->config->isSoundOutgoingEnabled(),
            'contactFormUrl' => $this->config->getContactFormUrl(),
            'aiEscalationEnabled' => $this->config->isAiEscalationEnabled(),
        ]);
    }
}
```

- [ ] **Step 2: Register controller and commit**

Add to `services.xml`:

```xml
        <service id="VoltimaxChat\Controller\Storefront\ChatWidgetController" public="true">
            <argument type="service" id="VoltimaxChat\Config\PluginConfig"/>
            <argument type="service" id="VoltimaxChat\Security\RateLimitMiddleware"/>
        </service>
```

```bash
docker exec -it shopware-6.6.10.8 php bin/console cache:clear
git add src/Controller/Storefront/ src/Resources/config/services.xml
git commit -m "feat(server-a): widget config endpoint for storefront JS"
```

---

## Phase 4: Data Services

### Task 10: Customer Data Service

**Files:**
- Create: `src/Service/CustomerDataService.php`

- [ ] **Step 1: Implement and register**

Create `src/Service/CustomerDataService.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;

class CustomerDataService
{
    private EntityRepository $customerRepository;

    public function __construct(EntityRepository $customerRepository)
    {
        $this->customerRepository = $customerRepository;
    }

    public function getByEmail(string $email, Context $context): ?array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('email', $email));
        $criteria->addAssociation('defaultBillingAddress');
        $criteria->addAssociation('group');
        $criteria->setLimit(1);

        $customer = $this->customerRepository->search($criteria, $context)->first();
        if ($customer === null) {
            return null;
        }

        return [
            'id' => $customer->getId(),
            'email' => $customer->getEmail(),
            'firstName' => $customer->getFirstName(),
            'lastName' => $customer->getLastName(),
            'customerNumber' => $customer->getCustomerNumber(),
            'group' => $customer->getGroup()?->getName(),
            'createdAt' => $customer->getCreatedAt()?->format('Y-m-d'),
            'city' => $customer->getDefaultBillingAddress()?->getCity(),
        ];
    }

    public function getById(string $id, Context $context): ?array
    {
        $criteria = new Criteria([$id]);
        $criteria->addAssociation('defaultBillingAddress');
        $criteria->addAssociation('group');

        $customer = $this->customerRepository->search($criteria, $context)->first();
        if ($customer === null) {
            return null;
        }

        return [
            'id' => $customer->getId(),
            'email' => $customer->getEmail(),
            'firstName' => $customer->getFirstName(),
            'lastName' => $customer->getLastName(),
            'customerNumber' => $customer->getCustomerNumber(),
            'group' => $customer->getGroup()?->getName(),
        ];
    }
}
```

Add to `services.xml`:

```xml
        <!-- Data Services -->
        <service id="VoltimaxChat\Service\CustomerDataService">
            <argument type="service" id="customer.repository"/>
        </service>
```

- [ ] **Step 2: Commit**

```bash
git add src/Service/CustomerDataService.php src/Resources/config/services.xml
git commit -m "feat(server-a): customer data service"
```

---

### Task 11: Order Data Service

**Files:**
- Create: `src/Service/OrderDataService.php`

- [ ] **Step 1: Implement and register**

Create `src/Service/OrderDataService.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Sorting\FieldSorting;

class OrderDataService
{
    private EntityRepository $orderRepository;

    public function __construct(EntityRepository $orderRepository)
    {
        $this->orderRepository = $orderRepository;
    }

    public function getByOrderNumber(string $orderNumber, Context $context): ?array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('orderNumber', $orderNumber));
        $criteria->addAssociation('lineItems');
        $criteria->addAssociation('deliveries.shippingMethod');
        $criteria->addAssociation('stateMachineState');
        $criteria->addAssociation('transactions.stateMachineState');
        $criteria->setLimit(1);

        $order = $this->orderRepository->search($criteria, $context)->first();
        return $order ? $this->format($order) : null;
    }

    public function getByCustomerId(string $customerId, Context $context, int $limit = 5): array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('orderCustomer.customerId', $customerId));
        $criteria->addAssociation('lineItems');
        $criteria->addAssociation('deliveries.shippingMethod');
        $criteria->addAssociation('stateMachineState');
        $criteria->addAssociation('transactions.stateMachineState');
        $criteria->addSorting(new FieldSorting('orderDateTime', FieldSorting::DESCENDING));
        $criteria->setLimit($limit);

        return array_map(fn ($o) => $this->format($o), $this->orderRepository->search($criteria, $context)->getElements());
    }

    private function format($order): array
    {
        $lineItems = [];
        foreach ($order->getLineItems() ?? [] as $item) {
            $lineItems[] = [
                'label' => $item->getLabel(),
                'quantity' => $item->getQuantity(),
                'unitPrice' => $item->getUnitPrice(),
                'totalPrice' => $item->getTotalPrice(),
            ];
        }

        $deliveries = [];
        foreach ($order->getDeliveries() ?? [] as $delivery) {
            $deliveries[] = [
                'shippingMethod' => $delivery->getShippingMethod()?->getName(),
                'trackingCodes' => $delivery->getTrackingCodes(),
            ];
        }

        $paymentStatus = null;
        $txns = $order->getTransactions();
        if ($txns !== null && $txns->count() > 0) {
            $paymentStatus = $txns->last()?->getStateMachineState()?->getTechnicalName();
        }

        return [
            'orderNumber' => $order->getOrderNumber(),
            'orderDate' => $order->getOrderDateTime()?->format('Y-m-d H:i'),
            'status' => $order->getStateMachineState()?->getTechnicalName(),
            'statusLabel' => $order->getStateMachineState()?->getName(),
            'paymentStatus' => $paymentStatus,
            'totalAmount' => $order->getAmountTotal(),
            'currency' => $order->getCurrency()?->getIsoCode() ?? 'EUR',
            'lineItems' => $lineItems,
            'deliveries' => $deliveries,
        ];
    }
}
```

Add to `services.xml`:

```xml
        <service id="VoltimaxChat\Service\OrderDataService">
            <argument type="service" id="order.repository"/>
        </service>
```

- [ ] **Step 2: Commit**

```bash
git add src/Service/OrderDataService.php src/Resources/config/services.xml
git commit -m "feat(server-a): order data service with tracking and line items"
```

---

### Task 12: Product Data Service

**Files:**
- Create: `src/Service/ProductDataService.php`

- [ ] **Step 1: Implement and register**

Create `src/Service/ProductDataService.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Service;

use Shopware\Core\Defaults;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\ContainsFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;

class ProductDataService
{
    private EntityRepository $productRepository;

    public function __construct(EntityRepository $productRepository)
    {
        $this->productRepository = $productRepository;
    }

    public function getById(string $id, Context $context): ?array
    {
        $criteria = new Criteria([$id]);
        $criteria->addAssociation('manufacturer');
        $criteria->addAssociation('cover.media');
        $product = $this->productRepository->search($criteria, $context)->first();
        return $product ? $this->format($product) : null;
    }

    public function getByProductNumber(string $productNumber, Context $context): ?array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('productNumber', $productNumber));
        $criteria->addAssociation('manufacturer');
        $criteria->addAssociation('cover.media');
        $criteria->setLimit(1);
        $product = $this->productRepository->search($criteria, $context)->first();
        return $product ? $this->format($product) : null;
    }

    public function searchByName(string $term, Context $context, int $limit = 10): array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new ContainsFilter('name', $term));
        $criteria->addAssociation('manufacturer');
        $criteria->addAssociation('cover.media');
        $criteria->setLimit($limit);
        return array_map(fn ($p) => $this->format($p), $this->productRepository->search($criteria, $context)->getElements());
    }

    private function format($product): array
    {
        return [
            'id' => $product->getId(),
            'productNumber' => $product->getProductNumber(),
            'name' => $product->getTranslation('name'),
            'description' => $product->getTranslation('description'),
            'manufacturer' => $product->getManufacturer()?->getTranslation('name'),
            'price' => $product->getCurrencyPrice(Defaults::CURRENCY)?->getGross(),
            'stock' => $product->getAvailableStock(),
            'available' => $product->getAvailable(),
            'ean' => $product->getEan(),
            'coverUrl' => $product->getCover()?->getMedia()?->getUrl(),
        ];
    }
}
```

Add to `services.xml`:

```xml
        <service id="VoltimaxChat\Service\ProductDataService">
            <argument type="service" id="product.repository"/>
        </service>
```

- [ ] **Step 2: Commit**

```bash
git add src/Service/ProductDataService.php src/Resources/config/services.xml
git commit -m "feat(server-a): product data service with search"
```

---

### Task 13: CMS and B2B Data Services

**Files:**
- Create: `src/Service/CmsDataService.php`
- Create: `src/Service/B2bDataService.php`

- [ ] **Step 1: Implement CmsDataService**

Create `src/Service/CmsDataService.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;

class CmsDataService
{
    private EntityRepository $cmsPageRepository;
    private EntityRepository $categoryRepository;

    public function __construct(EntityRepository $cmsPageRepository, EntityRepository $categoryRepository)
    {
        $this->cmsPageRepository = $cmsPageRepository;
        $this->categoryRepository = $categoryRepository;
    }

    public function getCmsPages(Context $context, int $limit = 50): array
    {
        $criteria = new Criteria();
        $criteria->addAssociation('sections.blocks.slots');
        $criteria->setLimit($limit);

        $result = [];
        foreach ($this->cmsPageRepository->search($criteria, $context) as $page) {
            $text = $this->extractText($page);
            if ($text !== '') {
                $result[] = ['id' => $page->getId(), 'name' => $page->getTranslation('name'), 'type' => $page->getType(), 'content' => $text];
            }
        }
        return $result;
    }

    public function getCategories(Context $context, int $limit = 100): array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('active', true));
        $criteria->setLimit($limit);

        $result = [];
        foreach ($this->categoryRepository->search($criteria, $context) as $cat) {
            $result[] = ['id' => $cat->getId(), 'name' => $cat->getTranslation('name'), 'description' => $cat->getTranslation('description'), 'type' => $cat->getType()];
        }
        return $result;
    }

    private function extractText($page): string
    {
        $texts = [];
        foreach ($page->getSections() ?? [] as $section) {
            foreach ($section->getBlocks() ?? [] as $block) {
                foreach ($block->getSlots() ?? [] as $slot) {
                    $config = $slot->getConfig();
                    if (isset($config['content']['value'])) {
                        $text = trim(strip_tags((string) $config['content']['value']));
                        if ($text !== '') {
                            $texts[] = $text;
                        }
                    }
                }
            }
        }
        return implode("\n\n", $texts);
    }
}
```

- [ ] **Step 2: Implement B2bDataService**

Create `src/Service/B2bDataService.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;

class B2bDataService
{
    private EntityRepository $customerRepository;

    public function __construct(EntityRepository $customerRepository)
    {
        $this->customerRepository = $customerRepository;
    }

    public function getB2bContext(string $customerId, Context $context): array
    {
        $criteria = new Criteria([$customerId]);
        $criteria->addAssociation('group');

        $customer = $this->customerRepository->search($criteria, $context)->first();
        if ($customer === null) {
            return ['is_b2b' => false];
        }

        $groupName = $customer->getGroup()?->getName() ?? '';
        $isB2b = str_contains(strtolower($groupName), 'b2b')
              || str_contains(strtolower($groupName), 'business')
              || str_contains(strtolower($groupName), 'wholesale');

        return [
            'is_b2b' => $isB2b,
            'customer_group' => $groupName,
            'company' => $customer->getCompany(),
            'vatIds' => $customer->getVatIds(),
        ];
    }
}
```

- [ ] **Step 3: Register services and commit**

Add to `services.xml`:

```xml
        <service id="VoltimaxChat\Service\CmsDataService">
            <argument type="service" id="cms_page.repository"/>
            <argument type="service" id="category.repository"/>
        </service>

        <service id="VoltimaxChat\Service\B2bDataService">
            <argument type="service" id="customer.repository"/>
        </service>
```

```bash
git add src/Service/CmsDataService.php src/Service/B2bDataService.php src/Resources/config/services.xml
git commit -m "feat(server-a): CMS and B2B data services"
```

---

### Task 14: Data Provider Controller (Server B API)

**Files:**
- Create: `src/Controller/Api/DataProviderController.php`

- [ ] **Step 1: Implement DataProviderController**

Create `src/Controller/Api/DataProviderController.php`:

```php
<?php declare(strict_types=1);

namespace VoltimaxChat\Controller\Api;

use Shopware\Core\Framework\Context;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use VoltimaxChat\Config\PluginConfig;
use VoltimaxChat\Security\ApiKeyAuthenticator;
use VoltimaxChat\Service\B2bDataService;
use VoltimaxChat\Service\CmsDataService;
use VoltimaxChat\Service\CustomerDataService;
use VoltimaxChat\Service\OrderDataService;
use VoltimaxChat\Service\ProductDataService;

#[Route(defaults: ['_routeScope' => ['api']])]
class DataProviderController extends AbstractController
{
    private PluginConfig $config;
    private ApiKeyAuthenticator $auth;
    private CustomerDataService $customerData;
    private OrderDataService $orderData;
    private ProductDataService $productData;
    private CmsDataService $cmsData;
    private B2bDataService $b2bData;

    public function __construct(
        PluginConfig $config,
        ApiKeyAuthenticator $auth,
        CustomerDataService $customerData,
        OrderDataService $orderData,
        ProductDataService $productData,
        CmsDataService $cmsData,
        B2bDataService $b2bData
    ) {
        $this->config = $config;
        $this->auth = $auth;
        $this->customerData = $customerData;
        $this->orderData = $orderData;
        $this->productData = $productData;
        $this->cmsData = $cmsData;
        $this->b2bData = $b2bData;
    }

    #[Route(path: '/api/voltimax-chat/customer', name: 'api.voltimax.chat.customer', methods: ['GET'])]
    public function customer(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'customers');
        if ($err) return $err;

        $context = Context::createDefaultContext();
        $email = $request->query->get('email');
        $id = $request->query->get('id');

        if ($email) {
            $data = $this->customerData->getByEmail($email, $context);
        } elseif ($id) {
            $data = $this->customerData->getById($id, $context);
        } else {
            return new JsonResponse(['error' => 'Provide email or id'], Response::HTTP_BAD_REQUEST);
        }

        return $data ? new JsonResponse($data) : new JsonResponse(['error' => 'Not found'], Response::HTTP_NOT_FOUND);
    }

    #[Route(path: '/api/voltimax-chat/orders', name: 'api.voltimax.chat.orders', methods: ['GET'])]
    public function orders(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'orders');
        if ($err) return $err;

        $context = Context::createDefaultContext();
        $orderNumber = $request->query->get('orderNumber');
        $customerId = $request->query->get('customerId');

        if ($orderNumber) {
            $data = $this->orderData->getByOrderNumber($orderNumber, $context);
            return $data ? new JsonResponse($data) : new JsonResponse(['error' => 'Not found'], Response::HTTP_NOT_FOUND);
        }
        if ($customerId) {
            $limit = (int) ($request->query->get('limit') ?? 5);
            return new JsonResponse($this->orderData->getByCustomerId($customerId, $context, $limit));
        }
        return new JsonResponse(['error' => 'Provide orderNumber or customerId'], Response::HTTP_BAD_REQUEST);
    }

    #[Route(path: '/api/voltimax-chat/products', name: 'api.voltimax.chat.products', methods: ['GET'])]
    public function products(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'products');
        if ($err) return $err;

        $context = Context::createDefaultContext();
        $id = $request->query->get('id');
        $productNumber = $request->query->get('productNumber');
        $search = $request->query->get('search');

        if ($id) {
            $data = $this->productData->getById($id, $context);
            return $data ? new JsonResponse($data) : new JsonResponse(['error' => 'Not found'], Response::HTTP_NOT_FOUND);
        }
        if ($productNumber) {
            $data = $this->productData->getByProductNumber($productNumber, $context);
            return $data ? new JsonResponse($data) : new JsonResponse(['error' => 'Not found'], Response::HTTP_NOT_FOUND);
        }
        if ($search) {
            $limit = (int) ($request->query->get('limit') ?? 10);
            return new JsonResponse($this->productData->searchByName($search, $context, $limit));
        }
        return new JsonResponse(['error' => 'Provide id, productNumber, or search'], Response::HTTP_BAD_REQUEST);
    }

    #[Route(path: '/api/voltimax-chat/cms', name: 'api.voltimax.chat.cms', methods: ['GET'])]
    public function cms(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'cms');
        if ($err) return $err;

        $context = Context::createDefaultContext();
        $type = $request->query->get('type', 'pages');

        return new JsonResponse(
            $type === 'categories'
                ? $this->cmsData->getCategories($context)
                : $this->cmsData->getCmsPages($context)
        );
    }

    #[Route(path: '/api/voltimax-chat/b2b', name: 'api.voltimax.chat.b2b', methods: ['GET'])]
    public function b2b(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'b2bQuotes');
        if ($err) return $err;

        $customerId = $request->query->get('customerId');
        if (!$customerId) {
            return new JsonResponse(['error' => 'Provide customerId'], Response::HTTP_BAD_REQUEST);
        }
        return new JsonResponse($this->b2bData->getB2bContext($customerId, Context::createDefaultContext()));
    }

    #[Route(path: '/api/voltimax-chat/health', name: 'api.voltimax.chat.health', methods: ['GET'])]
    public function health(Request $request): JsonResponse
    {
        if (!$this->auth->authenticate($request)) {
            return new JsonResponse(['error' => 'Unauthorized'], Response::HTTP_UNAUTHORIZED);
        }
        return new JsonResponse(['status' => 'ok', 'plugin' => 'VoltimaxChat', 'enabled' => $this->config->isEnabled()]);
    }

    private function requireAuth(Request $request, string $scope): ?JsonResponse
    {
        if (!$this->auth->authenticate($request)) {
            return new JsonResponse(['error' => 'Unauthorized'], Response::HTTP_UNAUTHORIZED);
        }
        if (!$this->config->isEnabled()) {
            return new JsonResponse(['error' => 'Chat disabled'], Response::HTTP_SERVICE_UNAVAILABLE);
        }
        if (!$this->config->isScopeEnabled($scope)) {
            return new JsonResponse(['error' => "Scope '$scope' is disabled"], Response::HTTP_FORBIDDEN);
        }
        return null;
    }
}
```

- [ ] **Step 2: Register controller and commit**

Add to `services.xml`:

```xml
        <service id="VoltimaxChat\Controller\Api\DataProviderController" public="true">
            <argument type="service" id="VoltimaxChat\Config\PluginConfig"/>
            <argument type="service" id="VoltimaxChat\Security\ApiKeyAuthenticator"/>
            <argument type="service" id="VoltimaxChat\Service\CustomerDataService"/>
            <argument type="service" id="VoltimaxChat\Service\OrderDataService"/>
            <argument type="service" id="VoltimaxChat\Service\ProductDataService"/>
            <argument type="service" id="VoltimaxChat\Service\CmsDataService"/>
            <argument type="service" id="VoltimaxChat\Service\B2bDataService"/>
        </service>
```

```bash
docker exec -it shopware-6.6.10.8 php bin/console cache:clear
docker exec -it shopware-6.6.10.8 php bin/console debug:router | grep voltimax
git add src/Controller/Api/DataProviderController.php src/Resources/config/services.xml
git commit -m "feat(server-a): data provider API for Server B"
```

---

## Phase 5: Storefront Widget

### Task 15: Twig Base Template

**Files:**
- Create: `src/Resources/views/storefront/layout/base.html.twig`

- [ ] **Step 1: Create template**

Create `src/Resources/views/storefront/layout/base.html.twig`:

```twig
{% sw_extends '@Storefront/storefront/layout/base.html.twig' %}

{% block base_body_script %}
    {{ parent() }}

    {% set chatConfig = config('VoltimaxChat.config') %}

    {% if chatConfig.enabled is defined and chatConfig.enabled %}
        <div id="voltimax-chat-root"
             data-voltimax-chat="true"
             data-voltimax-chat-options='{{ {
                 configUrl: path('voltimax.chat.config'),
                 consentUrl: path('voltimax.chat.consent'),
                 verifyUrl: path('voltimax.chat.verify')
             }|json_encode|raw }}'
             style="display: none;">
        </div>
    {% endif %}
{% endblock %}
```

- [ ] **Step 2: Compile and commit**

```bash
docker exec -it shopware-6.6.10.8 php bin/console cache:clear
docker exec -it shopware-6.6.10.8 php bin/console theme:compile
git add src/Resources/views/
git commit -m "feat(server-a): twig template injects chat widget"
```

---

### Task 16: Storefront JS Plugin

**Files:**
- Create: `src/Resources/app/storefront/src/main.js`
- Create: `src/Resources/app/storefront/src/voltimax-chat/voltimax-chat.plugin.js`

- [ ] **Step 1: Create main.js entry**

Create `src/Resources/app/storefront/src/main.js`:

```javascript
import VoltimaxChatPlugin from './voltimax-chat/voltimax-chat.plugin';

const PluginManager = window.PluginManager;
PluginManager.register('VoltimaxChat', VoltimaxChatPlugin, '[data-voltimax-chat]');
```

- [ ] **Step 2: Create the chat plugin**

Create `src/Resources/app/storefront/src/voltimax-chat/voltimax-chat.plugin.js` with the full state-machine widget. This file implements the complete flow: CLOSED, OPEN, CONSENT, VERIFICATION, TOPICS, CHATTING. It handles config loading, consent/verify API calls, WebSocket connection to Server B with SSE fallback, token-by-token streaming, topic cards with conditional visibility, and minimize/close lifecycle.

See the spec section 7 (Chat Widget Frontend) for the complete component behavior. The plugin registers as a Shopware storefront plugin via `PluginManager.register` and is initialized by the `data-voltimax-chat` attribute on the root element injected by the Twig template.

Key methods: `init()`, `_loadConfig()`, `_renderBubble()`, `_showConsent()`, `_showVerification()`, `_submitVerification()`, `_showTopics()`, `_startChat()`, `_connectToServerB()`, `_fallbackToSSE()`, `_onMessage()`, `_sendMessage()`, `_addMessage()`, `_appendToken()`.

All user-configurable strings are escaped via `textContent` assignment to prevent XSS.

- [ ] **Step 3: Build and commit**

```bash
docker exec -it shopware-6.6.10.8 ./bin/build-storefront.sh
git add src/Resources/app/storefront/src/
git commit -m "feat(server-a): storefront JS plugin with full chat flow"
```

---

### Task 17: SCSS Styles

**Files:**
- Create: `src/Resources/app/storefront/src/scss/voltimax-chat.scss` (imports all partials)
- Create: `src/Resources/app/storefront/src/scss/_variables.scss`
- Create: `src/Resources/app/storefront/src/scss/_widget.scss`
- Create: `src/Resources/app/storefront/src/scss/_messages.scss`
- Create: `src/Resources/app/storefront/src/scss/_cards.scss`
- Create: `src/Resources/app/storefront/src/scss/_consent.scss`
- Create: `src/Resources/app/storefront/src/scss/_dark-mode.scss`
- Create: `src/Resources/app/storefront/src/scss/_animations.scss`

See the spec section 7.2 (UI Behaviors) and 7.3 (Appearance Customization) for styling requirements. Key points:

- Widget: 380px wide, 560px tall, full-width on mobile <768px
- Primary color via CSS custom property `--vtx-primary` (set from admin config)
- z-index 99999 to float above storefront
- Dark mode class `.voltimax-chat-widget--dark` toggled by config
- Animations: slide-up for widget, fade-in for messages, staggered for topic cards
- Streaming cursor: blinking block character via `::after` pseudo-element

- [ ] **Step 1: Create all SCSS files** with the partials described above

- [ ] **Step 2: Build and commit**

```bash
docker exec -it shopware-6.6.10.8 ./bin/build-storefront.sh
docker exec -it shopware-6.6.10.8 php bin/console theme:compile
git add src/Resources/app/storefront/src/scss/
git commit -m "feat(server-a): chat widget SCSS with dark mode and animations"
```

---

### Task 18: Snippet Files

**Files:**
- Create: `src/Resources/snippet/de_DE/voltimax-chat.de-DE.json`
- Create: `src/Resources/snippet/en_GB/voltimax-chat.en-GB.json`

- [ ] **Step 1: Create German and English snippets**

German keys: `VoltimaxChat.widget.*`, `VoltimaxChat.consent.*`, `VoltimaxChat.verify.*`, `VoltimaxChat.chat.*`, `VoltimaxChat.topics.*`, `VoltimaxChat.escalation.*`

- [ ] **Step 2: Commit**

```bash
git add src/Resources/snippet/
git commit -m "feat(server-a): German and English translation snippets"
```

---

## Phase 6: Verification and Final Assembly

### Task 19: Full Integration Test

- [ ] **Step 1: Run all unit tests**

```bash
docker exec -it shopware-6.6.10.8 bash -c "cd /var/www/html/custom/plugins/voltimax-chat && php ../../vendor/bin/phpunit -v"
```

Expected: 15 tests pass (PluginConfig: 4, JWT: 5, ApiKeyAuth: 3, RateLimiter: 3).

- [ ] **Step 2: Verify all routes registered**

```bash
docker exec -it shopware-6.6.10.8 php bin/console debug:router | grep voltimax
```

Expected routes:
- `voltimax.chat.consent` POST `/voltimax-chat/consent`
- `voltimax.chat.verify` POST `/voltimax-chat/verify`
- `voltimax.chat.config` GET `/voltimax-chat/config`
- `api.voltimax.chat.customer` GET `/api/voltimax-chat/customer`
- `api.voltimax.chat.orders` GET `/api/voltimax-chat/orders`
- `api.voltimax.chat.products` GET `/api/voltimax-chat/products`
- `api.voltimax.chat.cms` GET `/api/voltimax-chat/cms`
- `api.voltimax.chat.b2b` GET `/api/voltimax-chat/b2b`
- `api.voltimax.chat.health` GET `/api/voltimax-chat/health`

- [ ] **Step 3: Manual smoke test**

1. Admin > Extensions > VoltimaxChat > set enabled=true, fill JWT secret
2. Open storefront > verify chat bubble appears
3. Click bubble > consent screen renders
4. Check consent box > click Continue > verification form renders

- [ ] **Step 4: Create CHANGELOG.md and final commit**

```bash
git add -A
git commit -m "feat(server-a): VoltimaxChat v1.0.0 complete Shopware plugin"
```

---

## API Reference

### Storefront Endpoints (no auth required)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/voltimax-chat/config` | Widget configuration JSON |
| POST | `/voltimax-chat/consent` | Log GDPR consent |
| POST | `/voltimax-chat/verify` | Verify customer, issue JWT |

### Server B Endpoints (require `X-Voltimax-Api-Key` header)

| Method | Path | Params | Purpose |
|--------|------|--------|---------|
| GET | `/api/voltimax-chat/health` | - | Health check |
| GET | `/api/voltimax-chat/customer` | `email` or `id` | Customer data |
| GET | `/api/voltimax-chat/orders` | `orderNumber` or `customerId` | Order data |
| GET | `/api/voltimax-chat/products` | `id`, `productNumber`, or `search` | Product data |
| GET | `/api/voltimax-chat/cms` | `type=pages\|categories` | CMS content for KB |
| GET | `/api/voltimax-chat/b2b` | `customerId` | B2B context |
