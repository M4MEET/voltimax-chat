<?php declare(strict_types=1);

namespace Voltimax\Chat\Util;

use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;

/**
 * Builders for the equals-filter criteria used throughout the data services.
 */
final class CriteriaFactory
{
    /**
     * @param array<string, mixed> $equals field => value, null values are skipped
     */
    public static function forEquals(array $equals, ?int $limit = null, array $associations = []): Criteria
    {
        $criteria = new Criteria();

        foreach ($equals as $field => $value) {
            if ($value === null) {
                continue;
            }
            $criteria->addFilter(new EqualsFilter($field, $value));
        }

        self::addAssociations($criteria, $associations);

        if ($limit !== null) {
            $criteria->setLimit($limit);
        }

        return $criteria;
    }

    public static function forIds(array $ids, array $associations = []): Criteria
    {
        return self::addAssociations(new Criteria($ids), $associations);
    }

    /**
     * @param string[] $associations
     */
    public static function addAssociations(Criteria $criteria, array $associations): Criteria
    {
        foreach ($associations as $association) {
            $criteria->addAssociation($association);
        }

        return $criteria;
    }
}
