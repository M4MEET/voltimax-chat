<?php declare(strict_types=1);

namespace Voltimax\Chat\Security;

use Psr\Cache\CacheItemPoolInterface;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Service\RateLimiterService;

class RateLimitMiddleware implements EventSubscriberInterface
{
    private RateLimiterService $rateLimiter;
    private PluginConfig $config;
    private CacheItemPoolInterface $cache;

    public function __construct(
        RateLimiterService $rateLimiter,
        PluginConfig $config,
        CacheItemPoolInterface $cache
    ) {
        $this->rateLimiter = $rateLimiter;
        $this->config = $config;
        $this->cache = $cache;
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
        $ip = $request->getClientIp() ?? 'unknown';

        if ($this->isBanned($ip)) {
            $event->setResponse(new JsonResponse(['error' => 'Access denied'], Response::HTTP_TOO_MANY_REQUESTS));
            $event->stopPropagation();
        }
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

    public function isSessionFlood(Request $request): bool
    {
        $ip = $request->getClientIp() ?? 'unknown';
        $generalLimit = $this->config->getRateLimitPerMinute();
        $key = 'voltimax_chat_rl_' . md5($ip . '_general');

        $item = $this->cache->getItem($key);
        if (!$item->isHit()) {
            return false;
        }

        $data = $item->get();
        $window = (int) (time() / 60);

        if (!isset($data['window']) || $data['window'] !== $window) {
            return false;
        }

        return ($data['count'] ?? 0) > $generalLimit * 3;
    }

    public function isRapidFire(Request $request): bool
    {
        $ip = $request->getClientIp() ?? 'unknown';
        $key = 'voltimax_chat_rf_' . md5($ip);
        $window = (int) (time() / 10);

        $item = $this->cache->getItem($key);
        $data = $item->isHit() ? $item->get() : ['window' => $window, 'count' => 0];

        if ($data['window'] !== $window) {
            $data = ['window' => $window, 'count' => 0];
        }

        $data['count']++;
        $item->set($data);
        $item->expiresAfter(20);
        $this->cache->save($item);

        return $data['count'] > 10;
    }

    public function isBanned(string $ip): bool
    {
        $key = 'voltimax_chat_ban_' . md5($ip);
        $item = $this->cache->getItem($key);
        return $item->isHit() && (bool) $item->get();
    }

    public function ban(string $ip, int $ttlSeconds = 3600): void
    {
        $key = 'voltimax_chat_ban_' . md5($ip);
        $item = $this->cache->getItem($key);
        $item->set(true);
        $item->expiresAfter($ttlSeconds);
        $this->cache->save($item);
    }
}
