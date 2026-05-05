<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

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
