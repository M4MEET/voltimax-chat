<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Util;

use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Voltimax\Chat\Util\CacheWindowCounter;

class CacheWindowCounterTest extends TestCase
{
    public function testHitCountsWithinTheSameWindow(): void
    {
        $counter = new CacheWindowCounter(new ArrayAdapter());

        static::assertSame(1, $counter->hit('key', 60, 120));
        static::assertSame(2, $counter->hit('key', 60, 120));
        static::assertSame(3, $counter->hit('key', 60, 120));
    }

    public function testCountDoesNotRecordAHit(): void
    {
        $counter = new CacheWindowCounter(new ArrayAdapter());
        $counter->hit('key', 60, 120);

        static::assertSame(1, $counter->count('key', 60));
        static::assertSame(1, $counter->count('key', 60));
    }

    public function testCountIsZeroForAnUnknownKey(): void
    {
        $counter = new CacheWindowCounter(new ArrayAdapter());

        static::assertSame(0, $counter->count('never-seen', 60));
    }

    public function testCountIgnoresAPreviousWindow(): void
    {
        $cache = new ArrayAdapter();
        $item = $cache->getItem('key');
        $item->set(['window' => (int) (time() / 60) - 1, 'count' => 99]);
        $cache->save($item);

        $counter = new CacheWindowCounter($cache);

        static::assertSame(0, $counter->count('key', 60));
        static::assertSame(1, $counter->hit('key', 60, 120));
    }

    public function testKeysAreDistinctPerIdentifier(): void
    {
        static::assertNotSame(
            CacheWindowCounter::key('prefix_', 'a'),
            CacheWindowCounter::key('prefix_', 'b')
        );
        static::assertStringStartsWith('prefix_', CacheWindowCounter::key('prefix_', 'a'));
    }

    public function testFlagExpressesABooleanMarker(): void
    {
        $counter = new CacheWindowCounter(new ArrayAdapter());

        static::assertFalse($counter->isFlagged('ban'));
        $counter->flag('ban', 3600);
        static::assertTrue($counter->isFlagged('ban'));
    }
}
