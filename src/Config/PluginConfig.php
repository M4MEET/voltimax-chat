<?php declare(strict_types=1);

namespace Voltimax\Chat\Config;

use Shopware\Core\System\SystemConfig\SystemConfigService;

class PluginConfig
{
    private const PREFIX = 'VoltimaxChat.config.';

    private SystemConfigService $systemConfig;

    public function __construct(SystemConfigService $systemConfig)
    {
        $this->systemConfig = $systemConfig;
    }

    public function isEnabled(?string $salesChannelId = null): bool
    {
        return (bool) $this->get('pluginEnabled', $salesChannelId);
    }

    public function getServerBUrl(?string $salesChannelId = null): ?string
    {
        return $this->get('serverBUrl', $salesChannelId);
    }

    public function getApiKey(?string $salesChannelId = null): ?string
    {
        return $this->get('sharedApiKey', $salesChannelId);
    }

    public function getJwtSecret(?string $salesChannelId = null): ?string
    {
        return $this->get('jwtSecret', $salesChannelId);
    }

    public function getJwtTtlSeconds(?string $salesChannelId = null): int
    {
        $minutes = (int) ($this->get('jwtTtlMinutes', $salesChannelId) ?? 30);
        return $minutes * 60;
    }

    public function getPrimaryColor(?string $salesChannelId = null): string
    {
        return $this->get('primaryColor', $salesChannelId) ?? '#4F46E5';
    }

    public function getLogoMediaId(?string $salesChannelId = null): ?string
    {
        return $this->get('logoMediaId', $salesChannelId);
    }

    public function getWidgetTitle(?string $salesChannelId = null): string
    {
        return $this->get('widgetTitle', $salesChannelId) ?? 'Chat Support';
    }

    public function getWelcomeMessage(?string $salesChannelId = null): string
    {
        return $this->get('welcomeMessage', $salesChannelId) ?? 'Hallo! Wie kann ich Ihnen helfen?';
    }

    public function getThemeMode(?string $salesChannelId = null): string
    {
        return $this->get('themeMode', $salesChannelId) ?? 'light';
    }

    public function getFontFamily(?string $salesChannelId = null): string
    {
        return $this->get('fontFamily', $salesChannelId) ?? 'system';
    }

    public function getBubbleSize(?string $salesChannelId = null): int
    {
        return (int) ($this->get('bubbleSize', $salesChannelId) ?? 60);
    }

    public function isAnimationsEnabled(?string $salesChannelId = null): bool
    {
        return (bool) ($this->get('animationsEnabled', $salesChannelId) ?? true);
    }

    public function getCustomCss(?string $salesChannelId = null): ?string
    {
        return $this->get('customCss', $salesChannelId);
    }

    public function getWidgetPosition(?string $salesChannelId = null): string
    {
        return $this->get('widgetPosition', $salesChannelId) ?? 'bottom-right';
    }

    public function getConsentText(?string $salesChannelId = null): string
    {
        return $this->get('consentText', $salesChannelId) ?? '';
    }

    public function getPrivacyPolicyUrl(?string $salesChannelId = null): ?string
    {
        return $this->get('privacyPolicyUrl', $salesChannelId);
    }

    public function getConsentCheckboxLabel(?string $salesChannelId = null): string
    {
        return $this->get('consentCheckboxLabel', $salesChannelId) ?? '';
    }

    public function isOrderNumberRequired(?string $salesChannelId = null): bool
    {
        return (bool) $this->get('requireOrderNumber', $salesChannelId);
    }

    public function isStrictValidation(?string $salesChannelId = null): bool
    {
        return (bool) $this->get('strictValidation', $salesChannelId);
    }

    public function isScopeEnabled(string $scope, ?string $salesChannelId = null): bool
    {
        $key = 'scope' . ucfirst($scope);
        return (bool) $this->get($key, $salesChannelId);
    }

    public function isSoundIncomingEnabled(?string $salesChannelId = null): bool
    {
        return (bool) ($this->get('soundIncoming', $salesChannelId) ?? true);
    }

    public function isSoundOutgoingEnabled(?string $salesChannelId = null): bool
    {
        return (bool) $this->get('soundOutgoing', $salesChannelId);
    }

    public function getContactFormUrl(?string $salesChannelId = null): ?string
    {
        return $this->get('contactFormUrl', $salesChannelId);
    }

    public function isAiEscalationEnabled(?string $salesChannelId = null): bool
    {
        return (bool) ($this->get('aiEscalationEnabled', $salesChannelId) ?? true);
    }

    public function getRateLimitPerMinute(?string $salesChannelId = null): int
    {
        return (int) ($this->get('rateLimitPerMinute', $salesChannelId) ?? 30);
    }

    public function getRateLimitVerifyPerMinute(?string $salesChannelId = null): int
    {
        return (int) ($this->get('rateLimitVerifyPerMinute', $salesChannelId) ?? 5);
    }

    public function getSecondaryColor(?string $salesChannelId = null): ?string
    {
        return $this->get('secondaryColor', $salesChannelId);
    }

    public function isDevModeEnabled(?string $salesChannelId = null): bool
    {
        return (bool) $this->get('devModeEnabled', $salesChannelId);
    }

    public function getDevModeSecret(?string $salesChannelId = null): string
    {
        return (string) ($this->get('devModeSecret', $salesChannelId) ?? '');
    }

    /** @return mixed */
    private function get(string $key, ?string $salesChannelId = null)
    {
        return $this->systemConfig->get(self::PREFIX . $key, $salesChannelId);
    }
}
