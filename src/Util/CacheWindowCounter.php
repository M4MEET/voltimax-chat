<?php declare(strict_types=1);

namespace Voltimax\Chat\Util;

use Psr\Cache\CacheItemPoolInterface;

/**
 * Fixed-window request counter backed by a PSR-6 cache. Counters are stored as
 * ['window' => <window index>, 'count' => <hits in that window>]; a hit in a new
 * window restarts the count.
 */
final class CacheWindowCounter
{
    private CacheItemPoolInterface $cache;

    public function __construct(CacheItemPoolInterface $cache)
    {
        $this->cache = $cache;
    }

    public static function key(string $prefix, string $identifier): string
    {
        return $prefix . md5($identifier);
    }

    /**
     * Records a hit and returns the number of hits in the current window.
     */
    public function hit(string $key, int $windowSeconds, int $ttlSeconds): int
    {
        $window = self::window($windowSeconds);

        $item = $this->cache->getItem($key);
        $data = $item->isHit() ? $item->get() : null;

        if (!is_array($data) || ($data['window'] ?? null) !== $window) {
            $data = ['window' => $window, 'count' => 0];
        }

        $data['count']++;
        $item->set($data);
        $item->expiresAfter($ttlSeconds);
        $this->cache->save($item);

        return $data['count'];
    }

    /**
     * Reads the hit count of the current window without recording a hit.
     */
    public function count(string $key, int $windowSeconds): int
    {
        $item = $this->cache->getItem($key);
        if (!$item->isHit()) {
            return 0;
        }

        $data = $item->get();
        if (!is_array($data) || ($data['window'] ?? null) !== self::window($windowSeconds)) {
            return 0;
        }

        return (int) ($data['count'] ?? 0);
    }

    public function isFlagged(string $key): bool
    {
        $item = $this->cache->getItem($key);
        return $item->isHit() && (bool) $item->get();
    }

    public function flag(string $key, int $ttlSeconds): void
    {
        $item = $this->cache->getItem($key);
        $item->set(true);
        $item->expiresAfter($ttlSeconds);
        $this->cache->save($item);
    }

    private static function window(int $windowSeconds): int
    {
        return (int) (time() / $windowSeconds);
    }
}
