<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

use Shopware\Core\Defaults;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\ContainsFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\MultiFilter;

class ProductDataService
{
    private EntityRepository $productRepository;

    public function __construct(EntityRepository $productRepository)
    {
        $this->productRepository = $productRepository;
    }

    public function getById(string $id, Context $context): ?array
    {
        $criteria = new Criteria([$id]);
        $this->addAssociations($criteria);
        $product = $this->productRepository->search($criteria, $context)->first();
        return $product ? $this->format($product) : null;
    }

    public function getByProductNumber(string $productNumber, Context $context): ?array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('productNumber', $productNumber));
        $this->addAssociations($criteria);
        $criteria->setLimit(1);
        $product = $this->productRepository->search($criteria, $context)->first();
        return $product ? $this->format($product) : null;
    }

    public function searchByName(string $term, Context $context, int $limit = 10): array
    {
        $criteria = new Criteria();

        // For multi-word terms, match products whose name contains ANY of the words.
        $words = array_values(array_filter(explode(' ', trim($term)), fn($w) => strlen($w) >= 3));
        if (count($words) > 1) {
            $filters = array_map(fn($w) => new ContainsFilter('name', $w), $words);
            $criteria->addFilter(new MultiFilter(MultiFilter::CONNECTION_OR, $filters));
        } else {
            $criteria->addFilter(new ContainsFilter('name', $term));
        }

        $this->addAssociations($criteria);
        $criteria->setLimit($limit);
        return array_values(array_map(fn ($p) => $this->format($p), $this->productRepository->search($criteria, $context)->getElements()));
    }

    public function getForCms(Context $context, int $limit = 50): array
    {
        $criteria = new Criteria();
        $this->addAssociations($criteria);
        $criteria->addFilter(new EqualsFilter('active', true));
        $criteria->setLimit($limit);

        return array_values(array_map(
            fn ($p) => $this->format($p),
            $this->productRepository->search($criteria, $context)->getElements()
        ));
    }

    private function addAssociations(Criteria $criteria): void
    {
        $criteria->addAssociation('manufacturer');
        $criteria->addAssociation('cover.media');
        $criteria->addAssociation('properties.group');
    }

    private function format($product): array
    {
        // Extract essential properties (grouped by property group name)
        $properties = [];
        if ($product->getProperties()) {
            foreach ($product->getProperties() as $property) {
                $groupName = $property->getGroup()?->getTranslation('name') ?? 'Other';
                $propName = $property->getTranslation('name') ?? '';
                if ($propName) {
                    $properties[$groupName] = $propName;
                }
            }
        }

        return [
            'id' => $product->getId(),
            'productNumber' => $product->getProductNumber(),
            'name' => $product->getTranslation('name'),
            'description' => $product->getTranslation('description'),
            'manufacturer' => $product->getManufacturer()?->getTranslation('name'),
            'price' => $product->getCurrencyPrice(Defaults::CURRENCY)?->getGross(),
            'stock' => $product->getAvailableStock(),
            'available' => $product->getAvailable(),
            'ean' => $product->getEan(),
            'coverUrl' => $product->getCover()?->getMedia()?->getUrl(),
            'properties' => $properties,
        ];
    }
}
