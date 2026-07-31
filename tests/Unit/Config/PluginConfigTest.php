<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Config;

use PHPUnit\Framework\TestCase;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use Voltimax\Chat\Config\PluginConfig;

class PluginConfigTest extends TestCase
{
    public function testIsEnabledReturnsFalseByDefault(): void
    {
        $systemConfig = $this->createStub(SystemConfigService::class);
        $systemConfig->method('get')->willReturn(null);

        $config = new PluginConfig($systemConfig);
        static::assertFalse($config->isEnabled());
    }

    public function testGetServerBUrlReturnsConfiguredUrl(): void
    {
        $systemConfig = $this->createStub(SystemConfigService::class);
        $systemConfig->method('get')
            ->willReturnMap([['VoltimaxChat.config.serverBUrl', null, 'https://ai.example.com']]);

        $config = new PluginConfig($systemConfig);
        static::assertSame('https://ai.example.com', $config->getServerBUrl());
    }

    public function testIsScopeEnabledChecksCorrectKey(): void
    {
        $systemConfig = $this->createStub(SystemConfigService::class);
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
        $systemConfig = $this->createStub(SystemConfigService::class);
        $systemConfig->method('get')->willReturn(30);

        $config = new PluginConfig($systemConfig);
        static::assertSame(1800, $config->getJwtTtlSeconds());
    }

    private function makeConfig(array $values = []): PluginConfig
    {
        $systemConfig = $this->createStub(SystemConfigService::class);
        $systemConfig->method('get')->willReturnCallback(
            fn (string $key) => $values[str_replace('VoltimaxChat.config.', '', $key)] ?? null
        );

        return new PluginConfig($systemConfig);
    }

    public function testUnconfiguredValuesFallBackToDefaults(): void
    {
        $config = $this->makeConfig();

        static::assertSame(1800, $config->getJwtTtlSeconds());
        static::assertSame('#D99A4E', $config->getPrimaryColor());
        static::assertSame('GrootDesk Support', $config->getWidgetTitle());
        static::assertSame('Hallo! Wie kann ich Ihnen helfen?', $config->getWelcomeMessage());
        static::assertSame('light', $config->getThemeMode());
        static::assertSame('system', $config->getFontFamily());
        static::assertSame(60, $config->getBubbleSize());
        static::assertSame('bottom-right', $config->getWidgetPosition());
        static::assertSame('', $config->getConsentText());
        static::assertSame('', $config->getConsentCheckboxLabel());
        static::assertSame('', $config->getDevModeSecret());
        static::assertSame(30, $config->getRateLimitPerMinute());
        static::assertSame(5, $config->getRateLimitVerifyPerMinute());
        static::assertTrue($config->isAnimationsEnabled());
        static::assertTrue($config->isSoundIncomingEnabled());
        static::assertTrue($config->isAiEscalationEnabled());
        static::assertFalse($config->isAgentImageEnabled());
        static::assertFalse($config->isSoundOutgoingEnabled());
        static::assertFalse($config->isApiSecretRequired());
        static::assertFalse($config->isOrderNumberRequired());
        static::assertFalse($config->isStrictValidation());
        static::assertFalse($config->isDevModeEnabled());
    }

    public function testUnconfiguredOptionalValuesAreNull(): void
    {
        $config = $this->makeConfig();

        static::assertNull($config->getServerBUrl());
        static::assertNull($config->getJwtSecret());
        static::assertNull($config->getLogoMediaId());
        static::assertNull($config->getAgentImageMediaId());
        static::assertNull($config->getCustomCss());
        static::assertNull($config->getPrivacyPolicyUrl());
        static::assertNull($config->getContactFormUrl());
        static::assertNull($config->getSecondaryColor());
    }

    public function testConfiguredValuesAreReturned(): void
    {
        $config = $this->makeConfig([
            'pluginEnabled' => true,
            'jwtSecret' => 'secret',
            'jwtTtlMinutes' => 5,
            'primaryColor' => '#000000',
            'secondaryColor' => '#FFFFFF',
            'logoMediaId' => 'logo-id',
            'agentImageEnabled' => true,
            'agentImageMediaId' => 'agent-id',
            'widgetTitle' => 'Support',
            'welcomeMessage' => 'Hi',
            'themeMode' => 'dark',
            'fontFamily' => 'serif',
            'bubbleSize' => 80,
            'animationsEnabled' => false,
            'customCss' => '.chat {}',
            'widgetPosition' => 'bottom-left',
            'consentText' => 'Consent',
            'consentCheckboxLabel' => 'I agree',
            'privacyPolicyUrl' => 'https://example.com/privacy',
            'contactFormUrl' => 'https://example.com/contact',
            'requireOrderNumber' => true,
            'strictValidation' => true,
            'soundIncoming' => false,
            'soundOutgoing' => true,
            'aiEscalationEnabled' => false,
            'rateLimitPerMinute' => 10,
            'rateLimitVerifyPerMinute' => 2,
            'devModeEnabled' => true,
            'devModeSecret' => 'dev-secret',
        ]);

        static::assertTrue($config->isEnabled());
        static::assertSame('secret', $config->getJwtSecret());
        static::assertSame(300, $config->getJwtTtlSeconds());
        static::assertSame('#000000', $config->getPrimaryColor());
        static::assertSame('#FFFFFF', $config->getSecondaryColor());
        static::assertSame('logo-id', $config->getLogoMediaId());
        static::assertTrue($config->isAgentImageEnabled());
        static::assertSame('agent-id', $config->getAgentImageMediaId());
        static::assertSame('Support', $config->getWidgetTitle());
        static::assertSame('Hi', $config->getWelcomeMessage());
        static::assertSame('dark', $config->getThemeMode());
        static::assertSame('serif', $config->getFontFamily());
        static::assertSame(80, $config->getBubbleSize());
        static::assertFalse($config->isAnimationsEnabled());
        static::assertSame('.chat {}', $config->getCustomCss());
        static::assertSame('bottom-left', $config->getWidgetPosition());
        static::assertSame('Consent', $config->getConsentText());
        static::assertSame('I agree', $config->getConsentCheckboxLabel());
        static::assertSame('https://example.com/privacy', $config->getPrivacyPolicyUrl());
        static::assertSame('https://example.com/contact', $config->getContactFormUrl());
        static::assertTrue($config->isOrderNumberRequired());
        static::assertTrue($config->isStrictValidation());
        static::assertFalse($config->isSoundIncomingEnabled());
        static::assertTrue($config->isSoundOutgoingEnabled());
        static::assertFalse($config->isAiEscalationEnabled());
        static::assertSame(10, $config->getRateLimitPerMinute());
        static::assertSame(2, $config->getRateLimitVerifyPerMinute());
        static::assertTrue($config->isDevModeEnabled());
        static::assertSame('dev-secret', $config->getDevModeSecret());
    }
}
