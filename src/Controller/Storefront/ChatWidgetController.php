<?php declare(strict_types=1);

namespace Voltimax\Chat\Controller\Storefront;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Security\RateLimitMiddleware;
use Voltimax\Chat\Util\MediaUrlResolver;

#[Route(defaults: ['_routeScope' => ['storefront'], 'XmlHttpRequest' => true])]
class ChatWidgetController extends AbstractController
{
    private PluginConfig $config;
    private RateLimitMiddleware $rateLimit;
    private MediaUrlResolver $mediaUrls;

    public function __construct(PluginConfig $config, RateLimitMiddleware $rateLimit, MediaUrlResolver $mediaUrls)
    {
        $this->config = $config;
        $this->rateLimit = $rateLimit;
        $this->mediaUrls = $mediaUrls;
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

        // A failed media lookup leaves the URL null: the widget falls back to
        // its SVG logo and simply shows no agent picture.
        $logoUrl = $this->mediaUrls->resolve($this->config->getLogoMediaId());

        // Agent picture is shown above the chat button on desktop/tablet
        $agentImageUrl = $this->config->isAgentImageEnabled()
            ? $this->mediaUrls->resolve($this->config->getAgentImageMediaId())
            : null;

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
