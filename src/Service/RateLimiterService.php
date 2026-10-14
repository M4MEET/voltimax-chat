<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

use Psr\Cache\CacheItemPoolInterface;
use Voltimax\Chat\Util\CacheWindowCounter;

class RateLimiterService
{
    public const KEY_PREFIX = 'voltimax_chat_rl_';
    public const WINDOW_SECONDS = 60;

    private CacheWindowCounter $counter;

    public function __construct(CacheItemPoolInterface $cache)
    {
        $this->counter = new CacheWindowCounter($cache);
    }

    public static function bucketKey(string $ip, string $bucket): string
    {
        return CacheWindowCounter::key(self::KEY_PREFIX, $ip . '_' . $bucket);
    }

    public function isAllowed(string $ip, string $bucket, int $maxPerMinute): bool
    {
        $hits = $this->counter->hit(self::bucketKey($ip, $bucket), self::WINDOW_SECONDS, 120);

        return $hits <= $maxPerMinute;
    }
}
