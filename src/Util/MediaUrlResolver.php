<?php declare(strict_types=1);

namespace Voltimax\Chat\Util;

use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use Shopware\Core\Content\Media\MediaEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;

/**
 * Resolves configured media IDs to public URLs. A failed lookup is logged and
 * yields null so callers can fall back to their default asset instead of erroring.
 */
class MediaUrlResolver
{
    private EntityRepository $mediaRepository;
    private LoggerInterface $logger;

    public function __construct(EntityRepository $mediaRepository, ?LoggerInterface $logger = null)
    {
        $this->mediaRepository = $mediaRepository;
        $this->logger = $logger ?? new NullLogger();
    }

    public function resolve(?string $mediaId, string $description = 'media'): ?string
    {
        if ($mediaId === null || $mediaId === '') {
            return null;
        }

        try {
            /** @var MediaEntity|null $media */
            $media = $this->mediaRepository
                ->search(CriteriaFactory::forIds([$mediaId]), Context::createDefaultContext())
                ->first();

            return $media?->getUrl();
        } catch (\Throwable $e) {
            $this->logger->warning(sprintf('VoltimaxChat: failed to resolve %s media', $description), [
                'mediaId'   => $mediaId,
                'exception' => $e,
            ]);

            return null;
        }
    }
}
