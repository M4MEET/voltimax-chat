<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Checkout\Order\Aggregate\OrderAddress\OrderAddressCollection;
use Shopware\Core\Checkout\Order\Aggregate\OrderAddress\OrderAddressEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderCustomer\OrderCustomerEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderDelivery\OrderDeliveryCollection;
use Shopware\Core\Checkout\Order\Aggregate\OrderDelivery\OrderDeliveryEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderLineItem\OrderLineItemCollection;
use Shopware\Core\Checkout\Order\Aggregate\OrderLineItem\OrderLineItemEntity;
use Shopware\Core\Checkout\Order\Aggregate\OrderTransaction\OrderTransactionCollection;
use Shopware\Core\Checkout\Order\Aggregate\OrderTransaction\OrderTransactionEntity;
use Shopware\Core\Checkout\Order\OrderEntity;
use Shopware\Core\Checkout\Payment\PaymentMethodEntity;
use Shopware\Core\Checkout\Shipping\ShippingMethodEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Shopware\Core\System\Country\CountryEntity;
use Shopware\Core\System\Currency\CurrencyEntity;
use Shopware\Core\System\StateMachine\Aggregation\StateMachineState\StateMachineStateEntity;
use Voltimax\Chat\Service\OrderDataService;

class OrderDataServiceTest extends TestCase
{
    private Context $context;

    protected function setUp(): void
    {
        $this->context = Context::createDefaultContext();
    }

    /**
     * @param OrderEntity[] $orders
     * @param callable(Criteria):void|null $criteriaSpy
     */
    private function makeService(array $orders, ?callable $criteriaSpy = null): OrderDataService
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('first')->willReturn($orders[0] ?? null);
        $result->method('getElements')->willReturn($orders);

        $repo = $this->createStub(EntityRepository::class);
        $repo->method('search')->willReturnCallback(
            function (Criteria $criteria) use ($result, $criteriaSpy) {
                if ($criteriaSpy !== null) {
                    $criteriaSpy($criteria);
                }
                return $result;
            }
        );

        return new OrderDataService($repo);
    }

    private function makeState(string $technicalName, string $name): StateMachineStateEntity
    {
        $state = new StateMachineStateEntity();
        $state->setId($technicalName . '-id');
        $state->setTechnicalName($technicalName);
        $state->setName($name);
        return $state;
    }

    private function makeOrder(): OrderEntity
    {
        $lineItem = new OrderLineItemEntity();
        $lineItem->setId('line-1');
        $lineItem->setLabel('Battery 12V');
        $lineItem->setQuantity(2);
        $lineItem->setUnitPrice(49.5);
        $lineItem->setTotalPrice(99.0);

        $shippingMethod = new ShippingMethodEntity();
        $shippingMethod->setId('shipping-id');
        $shippingMethod->setName('DHL');

        $delivery = new OrderDeliveryEntity();
        $delivery->setId('delivery-1');
        $delivery->setShippingMethod($shippingMethod);
        $delivery->setTrackingCodes(['TRACK-1']);
        $delivery->setStateMachineState($this->makeState('shipped', 'Shipped'));
        $delivery->setShippingDateEarliest(new \DateTimeImmutable('2024-05-02 08:00:00'));

        $paymentMethod = new PaymentMethodEntity();
        $paymentMethod->setId('payment-id');
        $paymentMethod->setName('Invoice');

        $transaction = new OrderTransactionEntity();
        $transaction->setId('txn-1');
        $transaction->setStateMachineState($this->makeState('paid', 'Paid'));
        $transaction->setPaymentMethod($paymentMethod);

        $country = new CountryEntity();
        $country->setId('country-id');
        $country->setName('Germany');

        $address = new OrderAddressEntity();
        $address->setId('billing-id');
        $address->setFirstName('Jane');
        $address->setLastName('Doe');
        $address->setStreet('Hauptstr. 1');
        $address->setZipcode('10115');
        $address->setCity('Berlin');
        $address->setCountry($country);

        $currency = new CurrencyEntity();
        $currency->setId('currency-id');
        $currency->setIsoCode('EUR');

        $orderCustomer = new OrderCustomerEntity();
        $orderCustomer->setId('order-customer-id');
        $orderCustomer->setEmail('jane@example.com');

        $order = new OrderEntity();
        $order->setId('order-id');
        $order->setOrderNumber('10001');
        $order->setOrderDateTime(new \DateTimeImmutable('2024-05-01 10:15:00'));
        $order->setStateMachineState($this->makeState('open', 'Open'));
        $order->setAmountTotal(99.0);
        $order->setCurrency($currency);
        $order->setLineItems(new OrderLineItemCollection([$lineItem]));
        $order->setDeliveries(new OrderDeliveryCollection([$delivery]));
        $order->setTransactions(new OrderTransactionCollection([$transaction]));
        $order->setBillingAddressId('billing-id');
        $order->setAddresses(new OrderAddressCollection([$address]));
        $order->setOrderCustomer($orderCustomer);

        return $order;
    }

    public function testGetByOrderNumberFormatsOrder(): void
    {
        $data = $this->makeService([$this->makeOrder()])->getByOrderNumber('10001', $this->context);

        static::assertSame('10001', $data['orderNumber']);
        static::assertSame('2024-05-01 10:15', $data['orderDate']);
        static::assertSame('open', $data['status']);
        static::assertSame('Open', $data['statusLabel']);
        static::assertSame('paid', $data['paymentStatus']);
        static::assertSame('Invoice', $data['paymentMethod']);
        static::assertSame(99.0, $data['totalAmount']);
        static::assertSame('EUR', $data['currency']);
        static::assertSame('jane@example.com', $data['customerEmail']);
        static::assertSame('Berlin', $data['billingAddress']['city']);
        static::assertSame('Germany', $data['billingAddress']['country']);
        static::assertSame(
            [['label' => 'Battery 12V', 'quantity' => 2, 'unitPrice' => 49.5, 'totalPrice' => 99.0]],
            $data['lineItems']
        );
        static::assertSame([[
            'shippingMethod' => 'DHL',
            'trackingCodes' => ['TRACK-1'],
            'deliveryStatus' => 'shipped',
            'deliveryStatusLabel' => 'Shipped',
            'shippingDate' => '2024-05-02',
        ]], $data['deliveries']);
    }

    public function testGetByOrderNumberReturnsNullWhenMissing(): void
    {
        static::assertNull($this->makeService([])->getByOrderNumber('99999', $this->context));
    }

    public function testGetByOrderNumberAddsEmailFilterOnlyWhenProvided(): void
    {
        $withEmail = null;
        $this->makeService([$this->makeOrder()], function (Criteria $c) use (&$withEmail) {
            $withEmail = json_encode($c->getFilters());
        })->getByOrderNumber('10001', $this->context, 'jane@example.com');
        static::assertStringContainsString('orderCustomer.email', (string) $withEmail);

        $withoutEmail = null;
        $this->makeService([$this->makeOrder()], function (Criteria $c) use (&$withoutEmail) {
            $withoutEmail = json_encode($c->getFilters());
        })->getByOrderNumber('10001', $this->context, '');
        static::assertStringNotContainsString('orderCustomer.email', (string) $withoutEmail);
    }

    public function testGetByCustomerIdSortsByDateAndUsesLimit(): void
    {
        $criteria = null;
        $orders = $this->makeService([$this->makeOrder()], function (Criteria $c) use (&$criteria) {
            $criteria = $c;
        })->getByCustomerId('customer-id', $this->context, 3);

        static::assertCount(1, $orders);
        static::assertSame('10001', $orders[0]['orderNumber']);
        static::assertNotNull($criteria);
        static::assertSame(3, $criteria->getLimit());
        static::assertSame('orderDateTime', $criteria->getSorting()[0]->getField());
        static::assertSame('DESC', $criteria->getSorting()[0]->getDirection());
    }

    public function testGetByCustomerIdReturnsEmptyArrayWhenNoOrders(): void
    {
        static::assertSame([], $this->makeService([])->getByCustomerId('customer-id', $this->context));
    }

    public function testFormatHandlesOrderWithoutAssociations(): void
    {
        $order = new OrderEntity();
        $order->setId('bare-order');
        $order->setOrderNumber('10002');
        $order->setBillingAddressId('');
        $order->setOrderDateTime(new \DateTimeImmutable('2024-06-01 09:00:00'));
        $order->setAmountTotal(0.0);

        $data = $this->makeService([$order])->getByOrderNumber('10002', $this->context);

        static::assertSame('2024-06-01 09:00', $data['orderDate']);
        static::assertNull($data['status']);
        static::assertNull($data['paymentStatus']);
        static::assertNull($data['paymentMethod']);
        static::assertNull($data['billingAddress']);
        static::assertNull($data['customerEmail']);
        static::assertSame('EUR', $data['currency']);
        static::assertSame([], $data['lineItems']);
        static::assertSame([], $data['deliveries']);
    }

    public function testGetReturnsIsEmptyForKnownOrder(): void
    {
        static::assertSame([], $this->makeService([$this->makeOrder()])->getReturns('10001', $this->context));
    }

    public function testGetReturnsIsEmptyForUnknownOrder(): void
    {
        static::assertSame([], $this->makeService([])->getReturns('99999', $this->context));
    }
}
