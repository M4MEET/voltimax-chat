<?php declare(strict_types=1);

namespace Voltimax\Chat\Controller\Api;

use Shopware\Core\Framework\Context;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Security\ApiKeyAuthenticator;
use Voltimax\Chat\Service\B2bDataService;
use Voltimax\Chat\Service\CmsDataService;
use Voltimax\Chat\Service\CustomerDataService;
use Voltimax\Chat\Service\OrderDataService;
use Voltimax\Chat\Service\ProductDataService;
use Voltimax\Chat\Util\ApiResponse;

#[Route(defaults: ['_routeScope' => ['storefront']])]
class DataProviderController extends AbstractController
{
    private PluginConfig $config;
    private ApiKeyAuthenticator $auth;
    private CustomerDataService $customerData;
    private OrderDataService $orderData;
    private ProductDataService $productData;
    private CmsDataService $cmsData;
    private B2bDataService $b2bData;

    public function __construct(
        PluginConfig $config,
        ApiKeyAuthenticator $auth,
        CustomerDataService $customerData,
        OrderDataService $orderData,
        ProductDataService $productData,
        CmsDataService $cmsData,
        B2bDataService $b2bData
    ) {
        $this->config = $config;
        $this->auth = $auth;
        $this->customerData = $customerData;
        $this->orderData = $orderData;
        $this->productData = $productData;
        $this->cmsData = $cmsData;
        $this->b2bData = $b2bData;
    }

    #[Route(path: '/voltimax/api/health', name: 'api.voltimax.health', methods: ['GET'])]
    public function health(Request $request): JsonResponse
    {
        if (!$this->auth->authenticate($request)) {
            return ApiResponse::unauthorized();
        }
        return new JsonResponse(['status' => 'ok', 'plugin' => 'VoltimaxChat', 'enabled' => $this->config->isEnabled()]);
    }

    #[Route(path: '/voltimax/api/config', name: 'api.voltimax.config', methods: ['GET'])]
    public function pluginConfig(Request $request): JsonResponse
    {
        if (!$this->auth->authenticate($request)) {
            return ApiResponse::unauthorized();
        }
        return new JsonResponse([
            'enabled'             => $this->config->isEnabled(),
            'serverBUrl'          => $this->config->getServerBUrl(),
            'widgetTitle'         => $this->config->getWidgetTitle(),
            'welcomeMessage'      => $this->config->getWelcomeMessage(),
            'requireOrderNumber'  => $this->config->isOrderNumberRequired(),
            'aiEscalationEnabled' => $this->config->isAiEscalationEnabled(),
            'contactFormUrl'      => $this->config->getContactFormUrl(),
        ]);
    }

    #[Route(path: '/voltimax/api/customer/{email}', name: 'api.voltimax.customer', methods: ['GET'])]
    public function customer(string $email, Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'customers');
        if ($err) return $err;

        return ApiResponse::dataOrNotFound($this->customerData->getByEmail($email, Context::createDefaultContext()));
    }

    #[Route(path: '/voltimax/api/customer/{email}/addresses', name: 'api.voltimax.customer.addresses', methods: ['GET'])]
    public function customerAddresses(string $email, Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'customers');
        if ($err) return $err;

        $data = $this->customerData->getAddresses($email, Context::createDefaultContext());
        return new JsonResponse($data);
    }

    #[Route(path: '/voltimax/api/orders', name: 'api.voltimax.orders', methods: ['GET'])]
    public function orders(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'orders');
        if ($err) return $err;

        $context = Context::createDefaultContext();
        $orderNumber = $request->query->get('orderNumber');
        $customerId = $request->query->get('customerId');

        if ($orderNumber) {
            $customerEmail = $request->query->get('customerEmail') ?? null;
            return ApiResponse::dataOrNotFound($this->orderData->getByOrderNumber($orderNumber, $context, $customerEmail));
        }
        if ($customerId) {
            $limit = (int) ($request->query->get('limit') ?? 5);
            return new JsonResponse($this->orderData->getByCustomerId($customerId, $context, $limit));
        }
        return ApiResponse::badRequest('Provide orderNumber or customerId');
    }

    #[Route(path: '/voltimax/api/returns/{orderNumber}', name: 'api.voltimax.returns', methods: ['GET'])]
    public function returns(string $orderNumber, Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'orders');
        if ($err) return $err;

        $data = $this->orderData->getReturns($orderNumber, Context::createDefaultContext());
        return new JsonResponse($data);
    }

    #[Route(path: '/voltimax/api/products', name: 'api.voltimax.products', methods: ['GET'])]
    public function products(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'products');
        if ($err) return $err;

        $context = Context::createDefaultContext();
        $id = $request->query->get('id');
        $productNumber = $request->query->get('productNumber');
        $search = $request->query->get('search');

        if ($id) {
            return ApiResponse::dataOrNotFound($this->productData->getById($id, $context));
        }
        if ($productNumber) {
            return ApiResponse::dataOrNotFound($this->productData->getByProductNumber($productNumber, $context));
        }
        if ($search) {
            $limit = (int) ($request->query->get('limit') ?? 10);
            return new JsonResponse($this->productData->searchByName($search, $context, $limit));
        }
        return ApiResponse::badRequest('Provide id, productNumber, or search');
    }

    #[Route(path: '/voltimax/api/cms', name: 'api.voltimax.cms', methods: ['GET'])]
    public function cms(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'cms');
        if ($err) return $err;

        $context = Context::createDefaultContext();
        $type = $request->query->get('type', 'pages');

        return new JsonResponse(
            $type === 'categories'
                ? $this->cmsData->getCategories($context)
                : $this->cmsData->getCmsPages($context)
        );
    }

    #[Route(path: '/voltimax/api/cms/products', name: 'api.voltimax.cms.products', methods: ['GET'])]
    public function cmsProducts(Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'products');
        if ($err) return $err;

        $limit = (int) ($request->query->get('limit') ?? 50);
        $search = $request->query->get('search', '');
        $context = Context::createDefaultContext();

        $data = $search !== ''
            ? $this->productData->searchByName($search, $context, $limit)
            : $this->productData->getForCms($context, $limit);

        return new JsonResponse($data);
    }

    #[Route(path: '/voltimax/api/b2b/{customerId}', name: 'api.voltimax.b2b', methods: ['GET'])]
    public function b2b(string $customerId, Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'b2bQuotes');
        if ($err) return $err;

        return new JsonResponse($this->b2bData->getB2bContext($customerId, Context::createDefaultContext()));
    }

    #[Route(path: '/voltimax/api/b2b/{email}/quotes', name: 'api.voltimax.b2b.quotes', methods: ['GET'])]
    public function b2bQuotes(string $email, Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'b2bQuotes');
        if ($err) return $err;

        $salesChannelId = $request->query->get('salesChannelId', '');
        return new JsonResponse(
            $this->b2bData->getQuotes($email, $salesChannelId, Context::createDefaultContext())
        );
    }

    #[Route(path: '/voltimax/api/b2b/{email}/employees', name: 'api.voltimax.b2b.employees', methods: ['GET'])]
    public function b2bEmployees(string $email, Request $request): JsonResponse
    {
        $err = $this->requireAuth($request, 'b2bQuotes');
        if ($err) return $err;

        $salesChannelId = $request->query->get('salesChannelId', '');
        return new JsonResponse(
            $this->b2bData->getEmployeeAccounts($email, $salesChannelId, Context::createDefaultContext())
        );
    }

    private function requireAuth(Request $request, string $scope): ?JsonResponse
    {
        if (!$this->auth->authenticate($request)) {
            return ApiResponse::unauthorized();
        }
        if (!$this->config->isEnabled()) {
            return ApiResponse::chatDisabled();
        }
        if (!$this->config->isScopeEnabled($scope)) {
            return ApiResponse::forbidden("Scope '$scope' is disabled");
        }
        return null;
    }
}
