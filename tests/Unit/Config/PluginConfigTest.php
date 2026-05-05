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
}
