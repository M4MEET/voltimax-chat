<?php declare(strict_types=1);

namespace Voltimax\Chat\Controller\Api;

use Doctrine\DBAL\Connection;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\Uuid\Uuid;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Security\RateLimitMiddleware;
use Voltimax\Chat\Service\JwtTokenService;
use Voltimax\Chat\Util\ApiResponse;
use Voltimax\Chat\Util\CriteriaFactory;

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
        $blocked = $this->guard(fn () => $this->rateLimit->checkGeneralLimit($request));
        if ($blocked !== null) {
            return $blocked;
        }

        $payload = $this->payload($request);
        $email = $payload['email'];
        $name = $payload['name'];

        if ($name === '') {
            return ApiResponse::badRequest('Name is required');
        }

        $now = (new \DateTimeImmutable())->format('Y-m-d H:i:s.v');
        $this->connection->insert('voltimax_chat_consent_log', [
            'id' => Uuid::randomBytes(),
            'customer_email' => $email,
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
        $blocked = $this->guard(fn () => $this->rateLimit->checkVerifyLimit($request));
        if ($blocked !== null) {
            return $blocked;
        }

        $payload = $this->payload($request, ['orderNumber']);
        $email = $payload['email'];
        $name = $payload['name'];
        $orderNumber = $payload['orderNumber'];

        if ($name === '') {
            return ApiResponse::badRequest('Name is required');
        }

        if ($this->config->isOrderNumberRequired() && $orderNumber === '') {
            return ApiResponse::badRequest('Order number is required');
        }

        $context = Context::createDefaultContext();
        $customerContext = ['has_orders' => false, 'is_b2b' => false, 'customer_id' => null];

        if ($this->config->isStrictValidation()) {
            $criteria = CriteriaFactory::forEquals(['email' => $email], 1);
            $customer = $this->customerRepository->search($criteria, $context)->first();

            if ($customer === null) {
                return ApiResponse::unprocessable('Customer not found');
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
            $criteria = CriteriaFactory::forEquals(['orderNumber' => $orderNumber], 1, ['orderCustomer']);
            $order = $this->orderRepository->search($criteria, $context)->first();

            if ($order !== null) {
                $customerContext['has_orders'] = true;
                $orderCustomer = method_exists($order, 'getOrderCustomer') ? $order->getOrderCustomer() : null;
                if ($email !== '' && $orderCustomer !== null
                    && strcasecmp((string) $orderCustomer->getEmail(), $email) === 0) {
                    $emailVerified = true;
                }
            } elseif ($this->config->isStrictValidation()) {
                return ApiResponse::unprocessable('Order not found');
            }
        }

        if (!$customerContext['has_orders'] && $customerContext['customer_id'] !== null) {
            $criteria = CriteriaFactory::forEquals(
                ['orderCustomer.customerId' => $customerContext['customer_id']],
                1
            );
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

    /**
     * Rejects the request when the chat is switched off or the caller is rate limited.
     */
    private function guard(callable $rateLimitCheck): ?JsonResponse
    {
        if (!$this->config->isEnabled()) {
            return ApiResponse::chatDisabled();
        }

        return $rateLimitCheck();
    }

    /**
     * @param string[] $extraFields
     * @return array<string, string> trimmed field values, missing fields become ''
     */
    private function payload(Request $request, array $extraFields = []): array
    {
        $data = json_decode($request->getContent(), true);
        $data = is_array($data) ? $data : [];

        $values = [];
        foreach (array_merge(['email', 'name'], $extraFields) as $field) {
            $values[$field] = trim((string) ($data[$field] ?? ''));
        }

        return $values;
    }
}
