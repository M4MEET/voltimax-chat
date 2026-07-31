<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerGroup\CustomerGroupEntity;
use Shopware\Core\Checkout\Customer\CustomerCollection;
use Shopware\Core\Checkout\Customer\CustomerEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderLineItem\OrderLineItemCollection;
use Shopware\Core\Checkout\Order\Aggregate\OrderLineItem\OrderLineItemEntity;
use Shopware\Core\Checkout\Order\OrderCollection;
use Shopware\Core\Checkout\Order\OrderEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityCollection;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Shopware\Core\System\StateMachine\Aggregation\StateMachineState\StateMachineStateEntity;
use Voltimax\Chat\Service\B2bDataService;

class B2bDataServiceTest extends TestCase
{
    private Context $context;

    protected function setUp(): void
    {
        $this->context = Context::createDefaultContext();
    }

    private function makeRepo(EntityCollection $entities): EntityRepository
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('first')->willReturn($entities->first());
        $result->method('getElements')->willReturn($entities->getElements());
        $result->method('getIterator')->willReturnCallback(fn () => new \ArrayIterator($entities->getElements()));

        $repo = $this->createStub(EntityRepository::class);
        $repo->method('search')->willReturnCallback(fn (Criteria $criteria) => $result);

        return $repo;
    }

    private function makeCustomer(
        string $id = 'customer-id',
        ?string $groupName = null,
        ?string $company = null,
        string $email = 'jane@example.com'
    ): CustomerEntity {
        $customer = new CustomerEntity();
        $customer->setId($id);
        $customer->setEmail($email);
        $customer->setFirstName('Jane');
        $customer->setLastName('Doe');
        $customer->setCustomerNumber('C-' . $id);
        if ($company !== null) {
            $customer->setCompany($company);
        }
        $customer->setVatIds(['DE123456789']);

        if ($groupName !== null) {
            $group = new CustomerGroupEntity();
            $group->setId('group-' . $groupName);
            $group->setName($groupName);
            $customer->setGroup($group);
        }

        return $customer;
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('b2bGroupNames')]
    public function testGetB2bContextDetectsB2bGroups(string $groupName, bool $expected): void
    {
        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection([$this->makeCustomer('customer-id', $groupName)])),
            $this->makeRepo(new OrderCollection())
        );

        $result = $service->getB2bContext('customer-id', $this->context);

        static::assertSame($expected, $result['is_b2b']);
        static::assertSame($groupName, $result['customer_group']);
        static::assertSame(['DE123456789'], $result['vatIds']);
    }

    public static function b2bGroupNames(): array
    {
        return [
            'b2b' => ['B2B Kunden', true],
            'business' => ['Business Partners', true],
            'wholesale' => ['Wholesale', true],
            'retail' => ['Standard', false],
        ];
    }

    public function testGetB2bContextWithoutGroupIsNotB2b(): void
    {
        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection([$this->makeCustomer()])),
            $this->makeRepo(new OrderCollection())
        );

        $result = $service->getB2bContext('customer-id', $this->context);

        static::assertFalse($result['is_b2b']);
        static::assertSame('', $result['customer_group']);
    }

    public function testGetB2bContextReturnsFalseWhenCustomerMissing(): void
    {
        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection()),
            $this->makeRepo(new OrderCollection())
        );

        static::assertSame(['is_b2b' => false], $service->getB2bContext('missing', $this->context));
    }

    public function testGetQuotesMapsOpenOrders(): void
    {
        $lineItem = new OrderLineItemEntity();
        $lineItem->setId('line-1');
        $lineItem->setLabel('Battery 12V');
        $lineItem->setQuantity(3);
        $lineItem->setUnitPrice(20.0);

        $state = new StateMachineStateEntity();
        $state->setId('state-id');
        $state->setTechnicalName('open');

        $order = new OrderEntity();
        $order->setId('order-id');
        $order->setOrderNumber('10001');
        $order->setOrderDateTime(new \DateTimeImmutable('2024-05-01 10:15:00'));
        $order->setAmountTotal(60.0);
        $order->setStateMachineState($state);
        $order->setLineItems(new OrderLineItemCollection([$lineItem]));

        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection([$this->makeCustomer()])),
            $this->makeRepo(new OrderCollection([$order]))
        );

        $quotes = $service->getQuotes('jane@example.com', 'sales-channel-id', $this->context);

        static::assertSame([[
            'orderNumber' => '10001',
            'orderDate' => '2024-05-01 10:15',
            'total' => 60.0,
            'status' => 'open',
            'lineItems' => ['line-1' => ['label' => 'Battery 12V', 'quantity' => 3, 'price' => 20.0]],
        ]], $quotes);
    }

    public function testGetQuotesReturnsEmptyArrayWhenCustomerMissing(): void
    {
        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection()),
            $this->makeRepo(new OrderCollection())
        );

        static::assertSame([], $service->getQuotes('nobody@example.com', 'sales-channel-id', $this->context));
    }

    public function testGetEmployeeAccountsExcludesRequestingCustomer(): void
    {
        $requester = $this->makeCustomer('customer-1', null, 'Voltimax GmbH', 'jane@example.com');
        $colleague = $this->makeCustomer('customer-2', null, 'Voltimax GmbH', 'john@example.com');

        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection([$requester, $colleague])),
            $this->makeRepo(new OrderCollection())
        );

        $employees = $service->getEmployeeAccounts('jane@example.com', 'sales-channel-id', $this->context);

        static::assertCount(1, $employees);
        static::assertSame('john@example.com', $employees[0]['email']);
        static::assertSame('customer-2', $employees[0]['id']);
    }

    public function testGetEmployeeAccountsReturnsEmptyArrayWithoutCompany(): void
    {
        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection([$this->makeCustomer()])),
            $this->makeRepo(new OrderCollection())
        );

        static::assertSame([], $service->getEmployeeAccounts('jane@example.com', 'sales-channel-id', $this->context));
    }

    public function testGetEmployeeAccountsReturnsEmptyArrayWhenCustomerMissing(): void
    {
        $service = new B2bDataService(
            $this->makeRepo(new CustomerCollection()),
            $this->makeRepo(new OrderCollection())
        );

        static::assertSame([], $service->getEmployeeAccounts('nobody@example.com', 'sales-channel-id', $this->context));
    }
}
