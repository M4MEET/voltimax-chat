<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\ContainsFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\MultiFilter;
use Voltimax\Chat\Config\PluginConfig;

class CmsDataService
{
    private EntityRepository $cmsPageRepository;
    private EntityRepository $categoryRepository;
    private EntityRepository $salesChannelRepository;
    private PluginConfig $config;

    public function __construct(
        EntityRepository $cmsPageRepository,
        EntityRepository $categoryRepository,
        EntityRepository $salesChannelRepository,
        PluginConfig $config,
    ) {
        $this->cmsPageRepository = $cmsPageRepository;
        $this->categoryRepository = $categoryRepository;
        $this->salesChannelRepository = $salesChannelRepository;
        $this->config = $config;
    }

    public function getCmsPages(Context $context, int $limit = 50): array
    {
        $criteria = new Criteria();
        $criteria->addAssociation('sections.blocks.slots');
        $criteria->setLimit($limit);

        $result = [];
        foreach ($this->cmsPageRepository->search($criteria, $context) as $page) {
            $text = $this->extractText($page);
            if ($text !== '') {
                $result[] = ['id' => $page->getId(), 'name' => $page->getTranslation('name'), 'type' => $page->getType(), 'content' => $text];
            }
        }
        return $result;
    }

    public function getCategories(Context $context, int $limit = 200): array
    {
        // Collect category IDs from the configured sales channel (or all)
        $rootIds = $this->getNavigationRootIds($context);

        $result = [];
        $seen = [];

        // Fetch categories from each navigation tree (main + service + footer)
        foreach ($rootIds as $rootId) {
            $treeCriteria = new Criteria();
            $treeCriteria->addFilter(new EqualsFilter('active', true));
            $treeCriteria->addAssociation('cmsPage.sections.blocks.slots');
            $treeCriteria->addFilter(
                new MultiFilter(
                    MultiFilter::CONNECTION_OR,
                    [
                        new EqualsFilter('id', $rootId),
                        new EqualsFilter('parentId', $rootId),
                        new ContainsFilter('path', $rootId),
                    ]
                )
            );
            $treeCriteria->setLimit(50);

            foreach ($this->categoryRepository->search($treeCriteria, $context) as $cat) {
                if (!isset($seen[$cat->getId()])) {
                    $result[] = $this->formatCategory($cat);
                    $seen[$cat->getId()] = true;
                }
            }
        }

        return $result;
    }

    private function formatCategory($cat): array
    {
        $description = $cat->getTranslation('description') ?? '';

        // Extract CMS content from the category's assigned layout page
        $cmsContent = '';
        if ($cat->getCmsPage()) {
            $cmsContent = $this->extractText($cat->getCmsPage());
        }

        $text = trim($description . "\n\n" . $cmsContent);

        return [
            'id' => $cat->getId(),
            'name' => $cat->getTranslation('name'),
            'description' => $text ?: null,
            'type' => $cat->getType(),
        ];
    }

    private function getNavigationRootIds(Context $context): array
    {
        $configuredId = $this->config->getSalesChannelId();

        $criteria = new Criteria();
        if ($configuredId) {
            $criteria->setIds([$configuredId]);
        }
        $criteria->setLimit(10);

        $ids = [];
        foreach ($this->salesChannelRepository->search($criteria, $context) as $channel) {
            if ($channel->getNavigationCategoryId()) {
                $ids[] = $channel->getNavigationCategoryId();
            }
            if ($channel->getServiceCategoryId()) {
                $ids[] = $channel->getServiceCategoryId();
            }
            if ($channel->getFooterCategoryId()) {
                $ids[] = $channel->getFooterCategoryId();
            }
        }
        return array_unique($ids);
    }

    private function extractText($page): string
    {
        $texts = [];
        foreach ($page->getSections() ?? [] as $section) {
            foreach ($section->getBlocks() ?? [] as $block) {
                foreach ($block->getSlots() ?? [] as $slot) {
                    $config = $slot->getConfig();
                    if (isset($config['content']['value'])) {
                        $text = trim(strip_tags((string) $config['content']['value']));
                        if ($text !== '') {
                            $texts[] = $text;
                        }
                    }
                }
            }
        }
        return implode("\n\n", $texts);
    }
}
