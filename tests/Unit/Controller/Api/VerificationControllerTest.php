<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Controller\Api;

use Doctrine\DBAL\Connection;
use PHPUnit\Framework\TestCase;
use Shopware\Core\Checkout\Customer\CustomerEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderCustomer\OrderCustomerEntity;
use Shopware\Core\Checkout\Order\OrderEntity;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Controller\Api\VerificationController;
use Voltimax\Chat\Security\RateLimitMiddleware;
use Voltimax\Chat\Service\JwtTokenService;

class VerificationControllerTest extends TestCase
{
    private const SECRET = 'test-secret-key-that-is-long-enough';

    private function makeConfig(
        bool $enabled = true,
        bool $orderNumberRequired = false,
        bool $strictValidation = false
    ): PluginConfig {
        $config = $this->createStub(PluginConfig::class);
        $config->method('isEnabled')->willReturn($enabled);
        $config->method('isOrderNumberRequired')->willReturn($orderNumberRequired);
        $config->method('isStrictValidation')->willReturn($strictValidation);
        return $config;
    }

    private function makeRateLimit(?JsonResponse $general = null, ?JsonResponse $verify = null): RateLimitMiddleware
    {
        $rateLimit = $this->createStub(RateLimitMiddleware::class);
        $rateLimit->method('checkGeneralLimit')->willReturn($general);
        $rateLimit->method('checkVerifyLimit')->willReturn($verify);
        return $rateLimit;
    }

    private function makeRepo(?object $entity, int $total = 0): EntityRepository
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('first')->willReturn($entity);
        $result->method('getTotal')->willReturn($total);

        $repo = $this->createStub(EntityRepository::class);
        $repo->method('search')->willReturn($result);
        return $repo;
    }

    private function makeController(
        PluginConfig $config,
        ?RateLimitMiddleware $rateLimit = null,
        ?EntityRepository $customerRepository = null,
        ?EntityRepository $orderRepository = null,
        ?Connection $connection = null
    ): VerificationController {
        return new VerificationController(
            $config,
            new JwtTokenService(self::SECRET, 1800),
            $rateLimit ?? $this->makeRateLimit(),
            $customerRepository ?? $this->makeRepo(null),
            $orderRepository ?? $this->makeRepo(null),
            $connection ?? $this->createStub(Connection::class)
        );
    }

    private function makeRequest(array $payload): Request
    {
        return Request::create('/voltimax/verify', 'POST', [], [], [], [], json_encode($payload));
    }

    private function decode(JsonResponse $response): array
    {
        return json_decode((string) $response->getContent(), true);
    }

    private function makeCustomer(string $id = 'customer-id'): CustomerEntity
    {
        $customer = new CustomerEntity();
        $customer->setId($id);
        $customer->setEmail('jane@example.com');
        return $customer;
    }

    private function makeOrder(?string $customerEmail): OrderEntity
    {
        $order = new OrderEntity();
        $order->setId('order-id');
        $order->setOrderNumber('10001');

        if ($customerEmail !== null) {
            $orderCustomer = new OrderCustomerEntity();
            $orderCustomer->setId('order-customer-id');
            $orderCustomer->setEmail($customerEmail);
            $order->setOrderCustomer($orderCustomer);
        }

        return $order;
    }

    public function testConsentReturnsServiceUnavailableWhenPluginDisabled(): void
    {
        $response = $this->makeController($this->makeConfig(false))->consent($this->makeRequest(['name' => 'Jane']));

        static::assertSame(Response::HTTP_SERVICE_UNAVAILABLE, $response->getStatusCode());
    }

    public function testConsentPassesThroughRateLimitResponse(): void
    {
        $limited = new JsonResponse(['error' => 'Rate limit exceeded'], Response::HTTP_TOO_MANY_REQUESTS);
        $controller = $this->makeController($this->makeConfig(), $this->makeRateLimit($limited));

        static::assertSame($limited, $controller->consent($this->makeRequest(['name' => 'Jane'])));
    }

    public function testConsentRequiresName(): void
    {
        $response = $this->makeController($this->makeConfig())->consent($this->makeRequest(['email' => 'a@b.c']));

        static::assertSame(Response::HTTP_BAD_REQUEST, $response->getStatusCode());
        static::assertSame(['error' => 'Name is required'], $this->decode($response));
    }

    public function testConsentLogsConsentRow(): void
    {
        $connection = $this->createMock(Connection::class);
        $connection->expects(static::once())
            ->method('insert')
            ->with(
                'voltimax_chat_consent_log',
                static::callback(function (array $row): bool {
                    self::assertSame('jane@example.com', $row['customer_email']);
                    self::assertSame('Jane', $row['customer_name']);
                    self::assertSame($row['consented_at'], $row['created_at']);
                    return true;
                })
            );

        $controller = $this->makeController($this->makeConfig(), null, null, null, $connection);
        $response = $controller->consent($this->makeRequest(['email' => 'jane@example.com', 'name' => 'Jane']));

        static::assertSame(['success' => true], $this->decode($response));
    }

    public function testVerifyReturnsServiceUnavailableWhenPluginDisabled(): void
    {
        $response = $this->makeController($this->makeConfig(false))->verify($this->makeRequest(['name' => 'Jane']));

        static::assertSame(Response::HTTP_SERVICE_UNAVAILABLE, $response->getStatusCode());
    }

    public function testVerifyPassesThroughRateLimitResponse(): void
    {
        $limited = new JsonResponse(['error' => 'Too many verification attempts'], Response::HTTP_TOO_MANY_REQUESTS);
        $controller = $this->makeController($this->makeConfig(), $this->makeRateLimit(null, $limited));

        static::assertSame($limited, $controller->verify($this->makeRequest(['name' => 'Jane'])));
    }

    public function testVerifyRequiresName(): void
    {
        $response = $this->makeController($this->makeConfig())->verify($this->makeRequest([]));

        static::assertSame(Response::HTTP_BAD_REQUEST, $response->getStatusCode());
        static::assertSame(['error' => 'Name is required'], $this->decode($response));
    }

    public function testVerifyRequiresOrderNumberWhenConfigured(): void
    {
        $controller = $this->makeController($this->makeConfig(true, true));
        $response = $controller->verify($this->makeRequest(['name' => 'Jane']));

        static::assertSame(Response::HTTP_BAD_REQUEST, $response->getStatusCode());
        static::assertSame(['error' => 'Order number is required'], $this->decode($response));
    }

    public function testVerifyIssuesTokenWithoutOrderNumber(): void
    {
        $controller = $this->makeController($this->makeConfig());
        $response = $controller->verify($this->makeRequest(['name' => 'Jane', 'email' => 'jane@example.com']));

        $body = $this->decode($response);
        static::assertSame(
            ['has_orders' => false, 'is_b2b' => false, 'customer_id' => null],
            $body['context']
        );

        $claims = (new JwtTokenService(self::SECRET, 1800))->validate($body['token']);
        static::assertSame('jane@example.com', $claims['email']);
        static::assertSame('Jane', $claims['name']);
        static::assertFalse($claims['has_orders']);
    }

    public function testVerifyMarksEmailVerifiedWhenOrderMatchesEmail(): void
    {
        $controller = $this->makeController(
            $this->makeConfig(),
            null,
            null,
            $this->makeRepo($this->makeOrder('JANE@example.com'))
        );

        $response = $controller->verify(
            $this->makeRequest(['name' => 'Jane', 'email' => 'jane@example.com', 'orderNumber' => '10001'])
        );

        $body = $this->decode($response);
        static::assertTrue($body['context']['has_orders']);
        static::assertStringContainsString(
            '"email_verified":true',
            base64_decode(strtr(explode('.', $body['token'])[1], '-_', '+/'))
        );
    }

    public function testVerifyDoesNotMarkEmailVerifiedForDifferentEmail(): void
    {
        $controller = $this->makeController(
            $this->makeConfig(),
            null,
            null,
            $this->makeRepo($this->makeOrder('someone-else@example.com'))
        );

        $response = $controller->verify(
            $this->makeRequest(['name' => 'Jane', 'email' => 'jane@example.com', 'orderNumber' => '10001'])
        );

        $body = $this->decode($response);
        static::assertTrue($body['context']['has_orders']);
        static::assertStringContainsString(
            '"email_verified":false',
            base64_decode(strtr(explode('.', $body['token'])[1], '-_', '+/'))
        );
    }

    public function testStrictValidationRejectsUnknownCustomer(): void
    {
        $controller = $this->makeController($this->makeConfig(true, false, true));
        $response = $controller->verify($this->makeRequest(['name' => 'Jane', 'email' => 'jane@example.com']));

        static::assertSame(Response::HTTP_UNPROCESSABLE_ENTITY, $response->getStatusCode());
        static::assertSame(['error' => 'Customer not found'], $this->decode($response));
    }

    public function testStrictValidationRejectsUnknownOrder(): void
    {
        $controller = $this->makeController(
            $this->makeConfig(true, false, true),
            null,
            $this->makeRepo($this->makeCustomer()),
            $this->makeRepo(null)
        );

        $response = $controller->verify(
            $this->makeRequest(['name' => 'Jane', 'email' => 'jane@example.com', 'orderNumber' => '99999'])
        );

        static::assertSame(Response::HTTP_UNPROCESSABLE_ENTITY, $response->getStatusCode());
        static::assertSame(['error' => 'Order not found'], $this->decode($response));
    }

    public function testStrictValidationFallsBackToCustomerOrderLookup(): void
    {
        $controller = $this->makeController(
            $this->makeConfig(true, false, true),
            null,
            $this->makeRepo($this->makeCustomer()),
            $this->makeRepo(null, 2)
        );

        $body = $this->decode($controller->verify($this->makeRequest(['name' => 'Jane', 'email' => 'jane@example.com'])));

        static::assertSame('customer-id', $body['context']['customer_id']);
        static::assertTrue($body['context']['has_orders']);
    }
}
