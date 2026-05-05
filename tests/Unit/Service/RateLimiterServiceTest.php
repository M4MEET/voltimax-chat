<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Voltimax\Chat\Service\RateLimiterService;

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
