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

        return new JsonResponse([
            'enabled' => true,
            'serverBUrl' => $this->config->getServerBUrl(),
            'logoUrl' => $logoUrl,
            'widgetPosition' => $this->config->getWidgetPosition(),
            'primaryColor' => $this->config->getPrimaryColor(),
            'widgetTitle' => $this->config->getWidgetTitle(),
            'welcomeMessage' => $this->config->getWelcomeMessage(),
            'themeMode' => $this->config->getThemeMode(),
            'fontFamily' => $this->config->getFontFamily(),
            'bubbleSize' => $this->config->getBubbleSize(),
            'animationsEnabled' => $this->config->isAnimationsEnabled(),
            'customCss' => $this->config->getCustomCss(),
            'consentText' => $this->config->getConsentText(),
            'privacyPolicyUrl' => $this->config->getPrivacyPolicyUrl(),
            'consentCheckboxLabel' => $this->config->getConsentCheckboxLabel(),
            'requireOrderNumber' => $this->config->isOrderNumberRequired(),
            'soundIncoming' => $this->config->isSoundIncomingEnabled(),
            'soundOutgoing' => $this->config->isSoundOutgoingEnabled(),
            'contactFormUrl' => $this->config->getContactFormUrl(),
            'aiEscalationEnabled' => $this->config->isAiEscalationEnabled(),
        ]);
    }
}
