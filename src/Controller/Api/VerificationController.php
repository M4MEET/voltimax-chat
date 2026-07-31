<?php declare(strict_types=1);

namespace Voltimax\Chat\Controller\Api;

use Doctrine\DBAL\Connection;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\Uuid\Uuid;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Security\RateLimitMiddleware;
use Voltimax\Chat\Service\JwtTokenService;

#[Route(defaults: ['_routeScope' => ['storefront'], 'XmlHttpRequest' => true])]
class VerificationController extends AbstractController
{
    private PluginConfig $config;
    private JwtTokenService $jwt;
    private RateLimitMiddleware $rateLimit;
    private EntityRepository $customerRepository;
    private EntityRepository $orderRepository;
    private Connection $connection;

    public function __construct(
        PluginConfig $config,
        JwtTokenService $jwt,
        RateLimitMiddleware $rateLimit,
        EntityRepository $customerRepository,
        EntityRepository $orderRepository,
        Connection $connection
    ) {
        $this->config = $config;
        $this->jwt = $jwt;
        $this->rateLimit = $rateLimit;
        $this->customerRepository = $customerRepository;
        $this->orderRepository = $orderRepository;
        $this->connection = $connection;
    }

    #[Route(path: '/voltimax/consent', name: 'voltimax.chat.consent', methods: ['POST'])]
    public function consent(Request $request): JsonResponse
    {
        if (!$this->config->isEnabled()) {
            return new JsonResponse(['error' => 'Chat disabled'], Response::HTTP_SERVICE_UNAVAILABLE);
        }

        $rateLimitResponse = $this->rateLimit->checkGeneralLimit($request);
        if ($rateLimitResponse !== null) {
            return $rateLimitResponse;
        }

        $data = json_decode($request->getContent(), true);
        if (!is_array($data)) {
            return new JsonResponse(['error' => 'Invalid request body'], Response::HTTP_BAD_REQUEST);
        }
        $email = trim($data['email'] ?? '');
        $name = trim($data['name'] ?? '');

        if ($name === '') {
            return new JsonResponse(['error' => 'Name is required'], Response::HTTP_BAD_REQUEST);
        }

        $now = (new \DateTimeImmutable())->format('Y-m-d H:i:s.v');
        $this->connection->insert('voltimax_chat_consent_log', [
            'id' => Uuid::randomBytes(),
            'customer_email' => $email ?: '',
            'customer_name' => $name,
            'ip_address' => $request->getClientIp() ?? 'unknown',
            'consented_at' => $now,
            'created_at' => $now,
        ]);

        return new JsonResponse(['success' => true]);
    }

    #[Route(path: '/voltimax/verify', name: 'voltimax.chat.verify', methods: ['POST'])]
    public function verify(Request $request): JsonResponse
    {
        if (!$this->config->isEnabled()) {
            return new JsonResponse(['error' => 'Chat disabled'], Response::HTTP_SERVICE_UNAVAILABLE);
        }

        $rateLimitResponse = $this->rateLimit->checkVerifyLimit($request);
        if ($rateLimitResponse !== null) {
            return $rateLimitResponse;
        }

        $data = json_decode($request->getContent(), true);
        if (!is_array($data)) {
            return new JsonResponse(['error' => 'Invalid request body'], Response::HTTP_BAD_REQUEST);
        }
        $email = trim($data['email'] ?? '');
        $name = trim($data['name'] ?? '');
        $orderNumber = trim($data['orderNumber'] ?? '');

        if ($name === '') {
            return new JsonResponse(['error' => 'Name is required'], Response::HTTP_BAD_REQUEST);
        }

        if ($this->config->isOrderNumberRequired() && $orderNumber === '') {
            return new JsonResponse(['error' => 'Order number is required'], Response::HTTP_BAD_REQUEST);
        }

        $context = Context::createDefaultContext();
        $customerContext = ['has_orders' => false, 'is_b2b' => false, 'customer_id' => null];

        if ($this->config->isStrictValidation()) {
            $criteria = new Criteria();
            $criteria->addFilter(new EqualsFilter('email', $email));
            $criteria->setLimit(1);
            $customer = $this->customerRepository->search($criteria, $context)->first();

            if ($customer === null) {
                return new JsonResponse(['error' => 'Customer not found'], Response::HTTP_UNPROCESSABLE_ENTITY);
            }
            $customerContext['customer_id'] = $customer->getId();
        }

        // email_verified: only true when the caller demonstrated a connection
        // between the email and real shop data — i.e. the provided order number
        // exists AND belongs to that email (possession-style proof, same
        // philosophy as order+ZIP verification on Server B). Merely typing an
        // email that happens to exist as a customer is NOT verification.
        $emailVerified = false;

        if ($orderNumber !== '') {
            $criteria = new Criteria();
            $criteria->addFilter(new EqualsFilter('orderNumber', $orderNumber));
            $criteria->addAssociation('orderCustomer');
            $criteria->setLimit(1);
            $order = $this->orderRepository->search($criteria, $context)->first();

            if ($order !== null) {
                $customerContext['has_orders'] = true;
                $orderCustomer = method_exists($order, 'getOrderCustomer') ? $order->getOrderCustomer() : null;
                if ($email !== '' && $orderCustomer !== null
                    && strcasecmp((string) $orderCustomer->getEmail(), $email) === 0) {
                    $emailVerified = true;
                }
            } elseif ($this->config->isStrictValidation()) {
                return new JsonResponse(['error' => 'Order not found'], Response::HTTP_UNPROCESSABLE_ENTITY);
            }
        }

        if (!$customerContext['has_orders'] && $customerContext['customer_id'] !== null) {
            $criteria = new Criteria();
            $criteria->addFilter(new EqualsFilter('orderCustomer.customerId', $customerContext['customer_id']));
            $criteria->setLimit(1);
            $customerContext['has_orders'] = $this->orderRepository->search($criteria, $context)->getTotal() > 0;
        }

        $token = $this->jwt->create([
            'email' => $email ?: null,
            'name' => $name,
            'customer_id' => $customerContext['customer_id'],
            'has_orders' => $customerContext['has_orders'],
            'is_b2b' => $customerContext['is_b2b'],
            'email_verified' => $emailVerified,
        ]);

        return new JsonResponse(['token' => $token, 'context' => $customerContext]);
    }
}
