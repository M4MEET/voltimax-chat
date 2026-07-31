<?php declare(strict_types=1);

namespace Voltimax\Chat\Security;

use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Service\RateLimiterService;
use Voltimax\Chat\Util\ApiResponse;
use Voltimax\Chat\Util\CacheWindowCounter;

class RateLimitMiddleware implements EventSubscriberInterface
{
    private const BAN_PREFIX = 'voltimax_chat_ban_';
    private const RAPID_FIRE_PREFIX = 'voltimax_chat_rf_';
    private const RAPID_FIRE_WINDOW = 10;
    private const RAPID_FIRE_MAX = 10;

    private RateLimiterService $rateLimiter;
    private PluginConfig $config;
    private CacheWindowCounter $counter;

    public function __construct(
        RateLimiterService $rateLimiter,
        PluginConfig $config,
        CacheItemPoolInterface $cache
    ) {
        $this->rateLimiter = $rateLimiter;
        $this->config = $config;
        $this->counter = new CacheWindowCounter($cache);
    }

    public static function getSubscribedEvents(): array
    {
        return [
            KernelEvents::REQUEST => 'onKernelRequest',
        ];
    }

    public function onKernelRequest(RequestEvent $event): void
    {
        $request = $event->getRequest();

        // Only check bans on voltimax routes — don't interfere with the rest of the shop
        if (strpos($request->getPathInfo(), '/voltimax/') !== 0) {
            return;
        }

        $ip = $this->clientIp($request);

        if ($this->isBanned($ip)) {
            $event->setResponse(ApiResponse::tooManyRequests('Access denied'));
            $event->stopPropagation();
        }
    }

    public function checkGeneralLimit(Request $request): ?JsonResponse
    {
        return $this->checkLimit($request, 'general', $this->config->getRateLimitPerMinute(), 'Rate limit exceeded');
    }

    public function checkVerifyLimit(Request $request): ?JsonResponse
    {
        return $this->checkLimit(
            $request,
            'verify',
            $this->config->getRateLimitVerifyPerMinute(),
            'Too many verification attempts'
        );
    }

    public function isSessionFlood(Request $request): bool
    {
        $key = RateLimiterService::bucketKey($this->clientIp($request), 'general');
        $hits = $this->counter->count($key, RateLimiterService::WINDOW_SECONDS);

        return $hits > $this->config->getRateLimitPerMinute() * 3;
    }

    public function isRapidFire(Request $request): bool
    {
        $key = CacheWindowCounter::key(self::RAPID_FIRE_PREFIX, $this->clientIp($request));
        $hits = $this->counter->hit($key, self::RAPID_FIRE_WINDOW, 2 * self::RAPID_FIRE_WINDOW);

        return $hits > self::RAPID_FIRE_MAX;
    }

    public function isBanned(string $ip): bool
    {
        return $this->counter->isFlagged(CacheWindowCounter::key(self::BAN_PREFIX, $ip));
    }

    public function ban(string $ip, int $ttlSeconds = 3600): void
    {
        $this->counter->flag(CacheWindowCounter::key(self::BAN_PREFIX, $ip), $ttlSeconds);
    }

    private function checkLimit(Request $request, string $bucket, int $limit, string $message): ?JsonResponse
    {
        if (!$this->rateLimiter->isAllowed($this->clientIp($request), $bucket, $limit)) {
            return ApiResponse::tooManyRequests($message);
        }
        return null;
    }

    private function clientIp(Request $request): string
    {
        return $request->getClientIp() ?? 'unknown';
    }
}
