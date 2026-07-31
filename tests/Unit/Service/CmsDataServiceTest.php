<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Content\Category\CategoryCollection;
use Shopware\Core\Content\Category\CategoryEntity;
use Shopware\Core\Content\Cms\Aggregate\CmsBlock\CmsBlockCollection;
use Shopware\Core\Content\Cms\Aggregate\CmsBlock\CmsBlockEntity;
use Shopware\Core\Content\Cms\Aggregate\CmsSection\CmsSectionCollection;
use Shopware\Core\Content\Cms\Aggregate\CmsSection\CmsSectionEntity;
use Shopware\Core\Content\Cms\Aggregate\CmsSlot\CmsSlotCollection;
use Shopware\Core\Content\Cms\Aggregate\CmsSlot\CmsSlotEntity;
use Shopware\Core\Content\Cms\CmsPageCollection;
use Shopware\Core\Content\Cms\CmsPageEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityCollection;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Shopware\Core\System\SalesChannel\SalesChannelCollection;
use Shopware\Core\System\SalesChannel\SalesChannelEntity;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use Voltimax\Chat\Service\CmsDataService;

class CmsDataServiceTest extends TestCase
{
    private Context $context;

    protected function setUp(): void
    {
        $this->context = Context::createDefaultContext();
    }

    /** @param callable(Criteria):void|null $criteriaSpy */
    private function makeRepo(EntityCollection $entities, ?callable $criteriaSpy = null): EntityRepository
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('first')->willReturn($entities->first());
        $result->method('getElements')->willReturn($entities->getElements());
        $result->method('getIterator')->willReturnCallback(fn () => new \ArrayIterator($entities->getElements()));

        $repo = $this->createStub(EntityRepository::class);
        $repo->method('search')->willReturnCallback(function (Criteria $criteria) use ($result, $criteriaSpy) {
            if ($criteriaSpy !== null) {
                $criteriaSpy($criteria);
            }
            return $result;
        });

        return $repo;
    }

    private function makeService(
        EntityCollection $cmsPages,
        EntityCollection $categories,
        EntityCollection $salesChannels,
        ?string $configuredSalesChannelId = null,
        ?callable $categoryCriteriaSpy = null,
        ?callable $salesChannelCriteriaSpy = null
    ): CmsDataService {
        $systemConfig = $this->createStub(SystemConfigService::class);
        $systemConfig->method('get')->willReturn($configuredSalesChannelId);

        return new CmsDataService(
            $this->makeRepo($cmsPages),
            $this->makeRepo($categories, $categoryCriteriaSpy),
            $this->makeRepo($salesChannels, $salesChannelCriteriaSpy),
            $systemConfig
        );
    }

    private function makeCmsPage(string $id, string $name, array $slotContents): CmsPageEntity
    {
        $slots = [];
        foreach ($slotContents as $index => $content) {
            $slot = new CmsSlotEntity();
            $slot->setId($id . '-slot-' . $index);
            $slot->setSlot('slot-' . $index);
            $slot->setType('text');
            $slot->setConfig($content === null ? [] : ['content' => ['value' => $content]]);
            $slots[] = $slot;
        }

        $block = new CmsBlockEntity();
        $block->setId($id . '-block');
        $block->setSlots(new CmsSlotCollection($slots));

        $section = new CmsSectionEntity();
        $section->setId($id . '-section');
        $section->setBlocks(new CmsBlockCollection([$block]));

        $page = new CmsPageEntity();
        $page->setId($id);
        $page->setTranslated(['name' => $name]);
        $page->setType('landingpage');
        $page->setSections(new CmsSectionCollection([$section]));

        return $page;
    }

    private function makeSalesChannel(
        string $id,
        ?string $navigation = null,
        ?string $service = null,
        ?string $footer = null
    ): SalesChannelEntity {
        $channel = new SalesChannelEntity();
        $channel->setId($id);
        $channel->setNavigationCategoryId($navigation ?? '');
        $channel->setServiceCategoryId($service ?? '');
        $channel->setFooterCategoryId($footer ?? '');
        return $channel;
    }

    public function testGetCmsPagesExtractsAndStripsHtmlContent(): void
    {
        $page = $this->makeCmsPage('page-1', 'Shipping', ['<p>Free <b>shipping</b></p>', '  ', 'Second block']);

        $service = $this->makeService(
            new CmsPageCollection([$page]),
            new CategoryCollection(),
            new SalesChannelCollection()
        );

        static::assertSame([[
            'id' => 'page-1',
            'name' => 'Shipping',
            'type' => 'landingpage',
            'content' => "Free shipping\n\nSecond block",
        ]], $service->getCmsPages($this->context));
    }

    public function testGetCmsPagesSkipsPagesWithoutText(): void
    {
        $empty = $this->makeCmsPage('page-empty', 'Empty', [null, '   ']);

        $service = $this->makeService(
            new CmsPageCollection([$empty]),
            new CategoryCollection(),
            new SalesChannelCollection()
        );

        static::assertSame([], $service->getCmsPages($this->context));
    }

    public function testGetCategoriesReturnsEmptyArrayWithoutNavigationRoots(): void
    {
        $service = $this->makeService(
            new CmsPageCollection(),
            new CategoryCollection(),
            new SalesChannelCollection([$this->makeSalesChannel('channel-1')])
        );

        static::assertSame([], $service->getCategories($this->context));
    }

    public function testGetCategoriesMergesDescriptionAndCmsContent(): void
    {
        $category = new CategoryEntity();
        $category->setId('category-1');
        $category->setTranslated(['name' => 'Batteries', 'description' => 'All batteries']);
        $category->setType('page');
        $category->setCmsPage($this->makeCmsPage('page-1', 'Layout', ['<p>Layout text</p>']));

        $service = $this->makeService(
            new CmsPageCollection(),
            new CategoryCollection([$category]),
            new SalesChannelCollection([$this->makeSalesChannel('channel-1', 'nav-root')])
        );

        static::assertSame([[
            'id' => 'category-1',
            'name' => 'Batteries',
            'description' => "All batteries\n\nLayout text",
            'type' => 'page',
        ]], $service->getCategories($this->context));
    }

    public function testGetCategoriesReturnsNullDescriptionWhenEmpty(): void
    {
        $category = new CategoryEntity();
        $category->setId('category-1');
        $category->setTranslated(['name' => 'Batteries']);
        $category->setType('page');

        $service = $this->makeService(
            new CmsPageCollection(),
            new CategoryCollection([$category]),
            new SalesChannelCollection([$this->makeSalesChannel('channel-1', 'nav-root')])
        );

        static::assertNull($service->getCategories($this->context)[0]['description']);
    }

    public function testGetCategoriesDeduplicatesAcrossNavigationTrees(): void
    {
        $category = new CategoryEntity();
        $category->setId('category-1');
        $category->setTranslated(['name' => 'Batteries']);
        $category->setType('page');

        $searchedRoots = 0;
        $service = $this->makeService(
            new CmsPageCollection(),
            new CategoryCollection([$category]),
            new SalesChannelCollection([$this->makeSalesChannel('channel-1', 'nav-root', 'service-root', 'footer-root')]),
            null,
            function () use (&$searchedRoots) {
                $searchedRoots++;
            }
        );

        static::assertCount(1, $service->getCategories($this->context));
        static::assertSame(3, $searchedRoots);
    }

    public function testConfiguredSalesChannelRestrictsSalesChannelLookup(): void
    {
        $criteria = null;
        $service = $this->makeService(
            new CmsPageCollection(),
            new CategoryCollection(),
            new SalesChannelCollection([$this->makeSalesChannel('channel-1')]),
            'channel-1',
            null,
            function (Criteria $c) use (&$criteria) {
                $criteria = $c;
            }
        );

        $service->getCategories($this->context);

        static::assertSame(['channel-1'], $criteria->getIds());
    }
}
