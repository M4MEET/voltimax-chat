<?php declare(strict_types=1);

namespace Voltimax\Chat\Util;

use Shopware\Core\Content\Media\MediaEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;

/**
 * Resolves configured media IDs to public URLs. A failed lookup yields null so
 * callers can fall back to their default asset instead of erroring.
 */
class MediaUrlResolver
{
    private EntityRepository $mediaRepository;

    public function __construct(EntityRepository $mediaRepository)
    {
        $this->mediaRepository = $mediaRepository;
    }

    public function resolve(?string $mediaId): ?string
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
        } catch (\Throwable) {
            return null;
        }
    }
}
