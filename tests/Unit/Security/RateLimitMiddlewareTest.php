<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Security;

use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Security\RateLimitMiddleware;
use Voltimax\Chat\Service\RateLimiterService;

class RateLimitMiddlewareTest extends TestCase
{
    private ArrayAdapter $cache;

    protected function setUp(): void
    {
        $this->cache = new ArrayAdapter();
    }

    private function makeMiddleware(int $generalLimit = 30, int $verifyLimit = 5): RateLimitMiddleware
    {
        $config = $this->createStub(PluginConfig::class);
        $config->method('getRateLimitPerMinute')->willReturn($generalLimit);
        $config->method('getRateLimitVerifyPerMinute')->willReturn($verifyLimit);

        return new RateLimitMiddleware(new RateLimiterService($this->cache), $config, $this->cache);
    }

    private function makeRequest(string $path = '/voltimax/chat', string $ip = '203.0.113.5'): Request
    {
        return Request::create($path, 'GET', [], [], [], ['REMOTE_ADDR' => $ip]);
    }

    private function makeEvent(Request $request): RequestEvent
    {
        return new RequestEvent(
            $this->createStub(HttpKernelInterface::class),
            $request,
            HttpKernelInterface::MAIN_REQUEST
        );
    }

    public function testSubscribesToKernelRequest(): void
    {
        static::assertSame(['kernel.request' => 'onKernelRequest'], RateLimitMiddleware::getSubscribedEvents());
    }

    public function testNonVoltimaxRouteIsIgnoredEvenWhenBanned(): void
    {
        $middleware = $this->makeMiddleware();
        $middleware->ban('203.0.113.5');

        $event = $this->makeEvent($this->makeRequest('/checkout/cart'));
        $middleware->onKernelRequest($event);

        static::assertNull($event->getResponse());
    }

    public function testBannedIpOnVoltimaxRouteGetsTooManyRequests(): void
    {
        $middleware = $this->makeMiddleware();
        $middleware->ban('203.0.113.5');

        $event = $this->makeEvent($this->makeRequest());
        $middleware->onKernelRequest($event);

        $response = $event->getResponse();
        static::assertInstanceOf(JsonResponse::class, $response);
        static::assertSame(Response::HTTP_TOO_MANY_REQUESTS, $response->getStatusCode());
        static::assertTrue($event->isPropagationStopped());
    }

    public function testUnbannedIpPassesThrough(): void
    {
        $event = $this->makeEvent($this->makeRequest());
        $this->makeMiddleware()->onKernelRequest($event);

        static::assertNull($event->getResponse());
    }

    public function testCheckGeneralLimitReturnsNullUntilLimitExceeded(): void
    {
        $middleware = $this->makeMiddleware(2);
        $request = $this->makeRequest();

        static::assertNull($middleware->checkGeneralLimit($request));
        static::assertNull($middleware->checkGeneralLimit($request));

        $response = $middleware->checkGeneralLimit($request);
        static::assertInstanceOf(JsonResponse::class, $response);
        static::assertSame(Response::HTTP_TOO_MANY_REQUESTS, $response->getStatusCode());
        static::assertSame(['error' => 'Rate limit exceeded'], json_decode((string) $response->getContent(), true));
    }

    public function testCheckVerifyLimitUsesSeparateBucket(): void
    {
        $middleware = $this->makeMiddleware(2, 1);
        $request = $this->makeRequest();

        static::assertNull($middleware->checkVerifyLimit($request));
        static::assertNull($middleware->checkGeneralLimit($request));

        $response = $middleware->checkVerifyLimit($request);
        static::assertInstanceOf(JsonResponse::class, $response);
        static::assertSame(['error' => 'Too many verification attempts'], json_decode((string) $response->getContent(), true));
    }

    public function testIsSessionFloodFalseWithoutTraffic(): void
    {
        static::assertFalse($this->makeMiddleware(2)->isSessionFlood($this->makeRequest()));
    }

    public function testIsSessionFloodTrueAboveTripleGeneralLimit(): void
    {
        $middleware = $this->makeMiddleware(2);
        $request = $this->makeRequest();

        for ($i = 0; $i < 6; $i++) {
            $middleware->checkGeneralLimit($request);
        }
        static::assertFalse($middleware->isSessionFlood($request));

        $middleware->checkGeneralLimit($request);
        static::assertTrue($middleware->isSessionFlood($request));
    }

    public function testIsRapidFireOnlyAfterElevenRequests(): void
    {
        $middleware = $this->makeMiddleware();
        $request = $this->makeRequest();

        for ($i = 0; $i < 10; $i++) {
            static::assertFalse($middleware->isRapidFire($request));
        }
        static::assertTrue($middleware->isRapidFire($request));
    }

    public function testRapidFireIsTrackedPerIp(): void
    {
        $middleware = $this->makeMiddleware();

        for ($i = 0; $i < 11; $i++) {
            $middleware->isRapidFire($this->makeRequest('/voltimax/chat', '198.51.100.1'));
        }
        static::assertFalse($middleware->isRapidFire($this->makeRequest('/voltimax/chat', '198.51.100.2')));
    }

    public function testBanAndIsBanned(): void
    {
        $middleware = $this->makeMiddleware();

        static::assertFalse($middleware->isBanned('192.0.2.1'));
        $middleware->ban('192.0.2.1');
        static::assertTrue($middleware->isBanned('192.0.2.1'));
        static::assertFalse($middleware->isBanned('192.0.2.2'));
    }

    public function testRequestWithoutClientIpFallsBackToUnknown(): void
    {
        $middleware = $this->makeMiddleware(1);
        $request = Request::create('/voltimax/chat');
        $request->server->remove('REMOTE_ADDR');

        static::assertNull($middleware->checkGeneralLimit($request));
        static::assertInstanceOf(JsonResponse::class, $middleware->checkGeneralLimit($request));
    }
}
