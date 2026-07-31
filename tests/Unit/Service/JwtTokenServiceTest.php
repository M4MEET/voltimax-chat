<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Service\JwtTokenService;

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

    public function testValidateReturnsNullForMalformedToken(): void
    {
        static::assertNull($this->service->validate('not-a-jwt'));
    }

    public function testDefaultTtlIsThirtyMinutes(): void
    {
        $payload = (new JwtTokenService('test-secret-key-that-is-long-enough'))
            ->validate((new JwtTokenService('test-secret-key-that-is-long-enough'))->create([]));

        static::assertSame(1800, $payload['exp'] - $payload['iat']);
    }

    public function testUsesSecretAndTtlFromPluginConfig(): void
    {
        $config = $this->createStub(PluginConfig::class);
        $config->method('getJwtSecret')->willReturn('config-secret-key-long-enough-value');
        $config->method('getJwtTtlSeconds')->willReturn(600);

        $service = new JwtTokenService($config);
        $payload = $service->validate($service->create(['email' => 'test@example.com']));

        static::assertSame('test@example.com', $payload['email']);
        static::assertSame(600, $payload['exp'] - $payload['iat']);
    }

    public function testThrowsWhenSecretIsNotConfigured(): void
    {
        $config = $this->createStub(PluginConfig::class);
        $config->method('getJwtSecret')->willReturn(null);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('JWT secret is not configured');

        (new JwtTokenService($config))->create([]);
    }

    public function testValidateOnlyReturnsKnownClaims(): void
    {
        $payload = $this->service->validate($this->service->create([
            'email' => 'test@example.com',
            'customer_id' => 'customer-id',
            'has_orders' => true,
            'is_b2b' => false,
            'unexpected' => 'ignored',
        ]));

        static::assertSame('customer-id', $payload['customer_id']);
        static::assertTrue($payload['has_orders']);
        static::assertFalse($payload['is_b2b']);
        static::assertArrayNotHasKey('unexpected', $payload);
    }
}
