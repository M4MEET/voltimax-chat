<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Sorting\FieldSorting;
use Voltimax\Chat\Util\CriteriaFactory;

class OrderDataService
{
    private const ASSOCIATIONS = [
        'lineItems',
        'deliveries.shippingMethod',
        'deliveries.stateMachineState',
        'stateMachineState',
        'transactions.stateMachineState',
        'transactions.paymentMethod',
        'addresses',
        'orderCustomer',
    ];

    private EntityRepository $orderRepository;

    public function __construct(EntityRepository $orderRepository)
    {
        $this->orderRepository = $orderRepository;
    }

    public function getByOrderNumber(string $orderNumber, Context $context, ?string $customerEmail = null): ?array
    {
        $criteria = CriteriaFactory::forEquals([
            'orderNumber' => $orderNumber,
            'orderCustomer.email' => $customerEmail === '' ? null : $customerEmail,
        ], 1, self::ASSOCIATIONS);

        $order = $this->orderRepository->search($criteria, $context)->first();
        return $order ? $this->format($order) : null;
    }

    public function getByCustomerId(string $customerId, Context $context, int $limit = 5): array
    {
        $criteria = CriteriaFactory::forEquals(
            ['orderCustomer.customerId' => $customerId],
            null,
            self::ASSOCIATIONS
        );
        $criteria->addSorting(new FieldSorting('orderDateTime', FieldSorting::DESCENDING));
        $criteria->setLimit($limit);

        return array_values(array_map(fn ($o) => $this->format($o), $this->orderRepository->search($criteria, $context)->getElements()));
    }

    public function getReturns(string $orderNumber, Context $context): array
    {
        // First find the order by order number to confirm it exists
        $criteria = CriteriaFactory::forEquals(['orderNumber' => $orderNumber], 1);

        $order = $this->orderRepository->search($criteria, $context)->first();
        if ($order === null) {
            return [];
        }

        // Return order returns as empty array if no return_order support
        // (B2C returns may not be available in all Shopware configurations)
        return [];
    }

    private function format($order): array
    {
        $lineItems = [];
        foreach ($order->getLineItems() ?? [] as $item) {
            $lineItems[] = [
                'label' => $item->getLabel(),
                'quantity' => $item->getQuantity(),
                'unitPrice' => $item->getUnitPrice(),
                'totalPrice' => $item->getTotalPrice(),
            ];
        }

        $deliveries = [];
        foreach ($order->getDeliveries() ?? [] as $delivery) {
            $deliveries[] = [
                'shippingMethod' => $delivery->getShippingMethod()?->getName(),
                'trackingCodes' => $delivery->getTrackingCodes(),
                'deliveryStatus' => $delivery->getStateMachineState()?->getTechnicalName(),
                'deliveryStatusLabel' => $delivery->getStateMachineState()?->getName(),
                'shippingDate' => $delivery->getShippingDateEarliest()?->format('Y-m-d'),
            ];
        }

        $paymentStatus = null;
        $paymentMethod = null;
        $txns = $order->getTransactions();
        if ($txns !== null && $txns->count() > 0) {
            $lastTxn = $txns->last();
            $paymentStatus = $lastTxn?->getStateMachineState()?->getTechnicalName();
            $paymentMethod = $lastTxn?->getPaymentMethod()?->getName();
        }

        // Billing address from order addresses
        $billingAddress = null;
        $billingAddressId = $order->getBillingAddressId();
        $addresses = $order->getAddresses();
        if ($billingAddressId && $addresses !== null) {
            $addr = $addresses->get($billingAddressId);
            if ($addr) {
                $billingAddress = [
                    'firstName' => $addr->getFirstName(),
                    'lastName' => $addr->getLastName(),
                    'street' => $addr->getStreet(),
                    'zipcode' => $addr->getZipcode(),
                    'city' => $addr->getCity(),
                    'country' => $addr->getCountry()?->getName(),
                ];
            }
        }

        // Customer email
        $customerEmail = $order->getOrderCustomer()?->getEmail();

        return [
            'orderNumber' => $order->getOrderNumber(),
            'orderDate' => $order->getOrderDateTime()?->format('Y-m-d H:i'),
            'status' => $order->getStateMachineState()?->getTechnicalName(),
            'statusLabel' => $order->getStateMachineState()?->getName(),
            'paymentStatus' => $paymentStatus,
            'paymentMethod' => $paymentMethod,
            'totalAmount' => $order->getAmountTotal(),
            'currency' => $order->getCurrency()?->getIsoCode() ?? 'EUR',
            'customerEmail' => $customerEmail,
            'billingAddress' => $billingAddress,
            'lineItems' => $lineItems,
            'deliveries' => $deliveries,
        ];
    }
}
