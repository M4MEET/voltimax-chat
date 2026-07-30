<?php declare(strict_types=1);

namespace Voltimax\Chat\Controller\Storefront;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Shopware\Core\Content\Media\MediaEntity;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Security\RateLimitMiddleware;

#[Route(defaults: ['_routeScope' => ['storefront'], 'XmlHttpRequest' => true])]
class ChatWidgetController extends AbstractController
{
    private PluginConfig $config;
    private RateLimitMiddleware $rateLimit;
    private EntityRepository $mediaRepository;

    public function __construct(PluginConfig $config, RateLimitMiddleware $rateLimit, EntityRepository $mediaRepository)
    {
        $this->config = $config;
        $this->rateLimit = $rateLimit;
        $this->mediaRepository = $mediaRepository;
    }

    #[Route(path: '/voltimax/config', name: 'voltimax.chat.config', methods: ['GET'])]
    public function config(Request $request): JsonResponse
    {
        $rateLimitResponse = $this->rateLimit->checkGeneralLimit($request);
        if ($rateLimitResponse !== null) {
            return $rateLimitResponse;
        }

        if (!$this->config->isEnabled()) {
            return new JsonResponse(['enabled' => false]);
        }

        // Resolve logo media ID to URL
        $logoUrl = null;
        $logoMediaId = $this->config->getLogoMediaId();
        if ($logoMediaId) {
            try {
                $criteria = new Criteria([$logoMediaId]);
                /** @var MediaEntity|null $media */
                $media = $this->mediaRepository->search($criteria, \Shopware\Core\Framework\Context::createDefaultContext())->first();
                if ($media) {
                    $logoUrl = $media->getUrl();
                }
            } catch (\Throwable $e) {
                // Logo lookup failed — fallback to SVG
            }
        }

        // Resolve agent picture (shown above the chat button on desktop/tablet)
        $agentImageUrl = null;
        if ($this->config->isAgentImageEnabled()) {
            $agentMediaId = $this->config->getAgentImageMediaId();
            if ($agentMediaId) {
                try {
                    $criteria = new Criteria([$agentMediaId]);
                    /** @var MediaEntity|null $media */
                    $media = $this->mediaRepository->search($criteria, \Shopware\Core\Framework\Context::createDefaultContext())->first();
                    if ($media) {
                        $agentImageUrl = $media->getUrl();
                    }
                } catch (\Throwable $e) {
                    // Agent image lookup failed — widget simply shows no picture
                }
            }
        }

        return new JsonResponse([
            'enabled' => true,
            'serverBUrl' => $this->config->getServerBUrl(),
            'logoUrl' => $logoUrl,
            'agentImageUrl' => $agentImageUrl,
            'primaryColor' => $this->config->getPrimaryColor(),
            'secondaryColor' => $this->config->getSecondaryColor(),
            'widgetPosition' => $this->config->getWidgetPosition(),
            'widgetTitle' => $this->config->getWidgetTitle(),
            'welcomeMessage' => $this->config->getWelcomeMessage(),
            'themeMode' => $this->config->getThemeMode(),
            'customCss' => $this->config->getCustomCss(),
            'privacyPolicyUrl' => $this->config->getPrivacyPolicyUrl(),
            'contactFormUrl' => $this->config->getContactFormUrl(),
        ]);
    }
}
