<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
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
}
