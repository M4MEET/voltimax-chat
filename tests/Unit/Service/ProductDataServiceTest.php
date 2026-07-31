<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Content\Media\MediaEntity;
use Shopware\Core\Content\Product\Aggregate\ProductMedia\ProductMediaEntity;
use Shopware\Core\Content\Product\ProductEntity;
use Shopware\Core\Content\Property\Aggregate\PropertyGroupOption\PropertyGroupOptionCollection;
use Shopware\Core\Content\Property\Aggregate\PropertyGroupOption\PropertyGroupOptionEntity;
use Shopware\Core\Content\Property\PropertyGroupEntity;
use Shopware\Core\Defaults;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Pricing\Price;
use Shopware\Core\Framework\DataAbstractionLayer\Pricing\PriceCollection;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Voltimax\Chat\Service\ProductDataService;

class ProductDataServiceTest extends TestCase
{
    private Context $context;

    protected function setUp(): void
    {
        $this->context = Context::createDefaultContext();
    }

    /**
     * @param ProductEntity[] $products
     * @param callable(Criteria):void|null $criteriaSpy
     */
    private function makeService(array $products, ?callable $criteriaSpy = null): ProductDataService
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('first')->willReturn($products[0] ?? null);
        $result->method('getElements')->willReturn($products);

        $repo = $this->createStub(EntityRepository::class);
        $repo->method('search')->willReturnCallback(
            function (Criteria $criteria) use ($result, $criteriaSpy) {
                if ($criteriaSpy !== null) {
                    $criteriaSpy($criteria);
                }
                return $result;
            }
        );

        return new ProductDataService($repo);
    }

    private function makeProduct(): ProductEntity
    {
        $group = new PropertyGroupEntity();
        $group->setId('group-id');
        $group->setTranslated(['name' => 'Voltage']);

        $option = new PropertyGroupOptionEntity();
        $option->setId('option-id');
        $option->setGroup($group);
        $option->setTranslated(['name' => '12V']);

        $media = new MediaEntity();
        $media->setId('media-id');
        $media->setUrl('https://shop.example.com/battery.jpg');

        $cover = new ProductMediaEntity();
        $cover->setId('cover-id');
        $cover->setMedia($media);

        $manufacturer = new \Shopware\Core\Content\Product\Aggregate\ProductManufacturer\ProductManufacturerEntity();
        $manufacturer->setId('manufacturer-id');
        $manufacturer->setTranslated(['name' => 'Voltimax']);

        $product = new ProductEntity();
        $product->setId('product-id');
        $product->setProductNumber('SW-100');
        $product->setTranslated(['name' => 'Battery 12V', 'description' => 'A battery']);
        $product->setManufacturer($manufacturer);
        $product->setPrice(new PriceCollection([new Price(Defaults::CURRENCY, 41.0, 49.0, false)]));
        $product->setAvailableStock(7);
        $product->setAvailable(true);
        $product->setEan('EAN-1');
        $product->setCover($cover);
        $product->setProperties(new PropertyGroupOptionCollection([$option]));

        return $product;
    }

    public function testGetByIdFormatsProduct(): void
    {
        $data = $this->makeService([$this->makeProduct()])->getById('product-id', $this->context);

        static::assertSame([
            'id' => 'product-id',
            'productNumber' => 'SW-100',
            'name' => 'Battery 12V',
            'description' => 'A battery',
            'manufacturer' => 'Voltimax',
            'price' => 49.0,
            'stock' => 7,
            'available' => true,
            'ean' => 'EAN-1',
            'coverUrl' => 'https://shop.example.com/battery.jpg',
            'properties' => ['Voltage' => '12V'],
        ], $data);
    }

    public function testGetByIdReturnsNullWhenMissing(): void
    {
        static::assertNull($this->makeService([])->getById('missing', $this->context));
    }

    public function testGetByProductNumberReturnsFormattedProduct(): void
    {
        $criteria = null;
        $data = $this->makeService([$this->makeProduct()], function (Criteria $c) use (&$criteria) {
            $criteria = $c;
        })->getByProductNumber('SW-100', $this->context);

        static::assertSame('SW-100', $data['productNumber']);
        static::assertSame(1, $criteria->getLimit());
        static::assertStringContainsString('productNumber', json_encode($criteria->getFilters()));
    }

    public function testGetByProductNumberReturnsNullWhenMissing(): void
    {
        static::assertNull($this->makeService([])->getByProductNumber('SW-404', $this->context));
    }

    public function testSearchByNameUsesContainsFilterForSingleWord(): void
    {
        $criteria = null;
        $results = $this->makeService([$this->makeProduct()], function (Criteria $c) use (&$criteria) {
            $criteria = $c;
        })->searchByName('battery', $this->context);

        static::assertCount(1, $results);
        static::assertSame('Battery 12V', $results[0]['name']);
        static::assertCount(1, $criteria->getFilters());
        static::assertInstanceOf(
            \Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\ContainsFilter::class,
            $criteria->getFilters()[0]
        );
        static::assertSame(10, $criteria->getLimit());
    }

    public function testSearchByNameUsesOrMultiFilterForMultipleWords(): void
    {
        $criteria = null;
        $this->makeService([$this->makeProduct()], function (Criteria $c) use (&$criteria) {
            $criteria = $c;
        })->searchByName('battery 12v starter', $this->context, 5);

        $filter = $criteria->getFilters()[0];
        static::assertInstanceOf(
            \Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\MultiFilter::class,
            $filter
        );
        static::assertSame('OR', $filter->getOperator());
        static::assertCount(3, $filter->getQueries());
        static::assertSame(5, $criteria->getLimit());
    }

    public function testSearchByNameIgnoresShortWordsWhenCombining(): void
    {
        $criteria = null;
        $this->makeService([], function (Criteria $c) use (&$criteria) {
            $criteria = $c;
        })->searchByName('battery 6v', $this->context);

        // Only one word is >= 3 chars, so the plain ContainsFilter path is used
        static::assertInstanceOf(
            \Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\ContainsFilter::class,
            $criteria->getFilters()[0]
        );
    }

    public function testGetForCmsFiltersActiveProducts(): void
    {
        $criteria = null;
        $results = $this->makeService([$this->makeProduct()], function (Criteria $c) use (&$criteria) {
            $criteria = $c;
        })->getForCms($this->context, 20);

        static::assertCount(1, $results);
        static::assertSame(20, $criteria->getLimit());
        static::assertStringContainsString('active', json_encode($criteria->getFilters()));
    }

    public function testFormatSkipsPropertiesWithoutName(): void
    {
        $option = new PropertyGroupOptionEntity();
        $option->setId('option-id');
        $option->setTranslated(['name' => '']);

        $product = $this->makeProduct();
        $product->setProperties(new PropertyGroupOptionCollection([$option]));

        $data = $this->makeService([$product])->getById('product-id', $this->context);
        static::assertSame([], $data['properties']);
    }

    public function testFormatGroupsPropertiesWithoutGroupUnderOther(): void
    {
        $option = new PropertyGroupOptionEntity();
        $option->setId('option-id');
        $option->setTranslated(['name' => '12V']);

        $product = $this->makeProduct();
        $product->setProperties(new PropertyGroupOptionCollection([$option]));

        $data = $this->makeService([$product])->getById('product-id', $this->context);
        static::assertSame(['Other' => '12V'], $data['properties']);
    }

    public function testFormatHandlesProductWithoutAssociations(): void
    {
        $product = new ProductEntity();
        $product->setId('bare-product');
        $product->setProductNumber('SW-200');
        $product->setTranslated(['name' => 'Bare']);
        $product->setAvailable(false);

        $data = $this->makeService([$product])->getById('bare-product', $this->context);

        static::assertNull($data['manufacturer']);
        static::assertNull($data['price']);
        static::assertNull($data['coverUrl']);
        static::assertSame([], $data['properties']);
    }
}
