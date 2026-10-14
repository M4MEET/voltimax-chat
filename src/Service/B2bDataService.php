<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Voltimax\Chat\Util\CriteriaFactory;

class B2bDataService
{
    private EntityRepository $customerRepository;
    private EntityRepository $orderRepository;

    public function __construct(EntityRepository $customerRepository, EntityRepository $orderRepository)
    {
        $this->customerRepository = $customerRepository;
        $this->orderRepository    = $orderRepository;
    }

    public function getB2bContext(string $customerId, Context $context): array
    {
        $criteria = CriteriaFactory::forIds([$customerId], ['group']);

        $customer = $this->customerRepository->search($criteria, $context)->first();
        if ($customer === null) {
            return ['is_b2b' => false];
        }

        $groupName = $customer->getGroup()?->getName() ?? '';
        $isB2b = str_contains(strtolower($groupName), 'b2b')
              || str_contains(strtolower($groupName), 'business')
              || str_contains(strtolower($groupName), 'wholesale');

        return [
            'is_b2b' => $isB2b,
            'customer_group' => $groupName,
            'company' => $customer->getCompany(),
            'vatIds' => $customer->getVatIds(),
        ];
    }

    /**
     * Returns quote/order history for a customer by email in a given sales channel.
     * In standard Shopware 6.6, there are no native "quotes" — returns orders in
     * 'open' or 'in_progress' state that approximate a quote pipeline.
     */
    public function getQuotes(string $email, string $salesChannelId, Context $context): array
    {
        $customer = $this->findCustomerByEmail($email, $salesChannelId, $context);
        if ($customer === null) {
            return [];
        }

        // Return orders in open state as proxy for quotes
        $orderCriteria = CriteriaFactory::forEquals(
            [
                'orderCustomer.customerId' => $customer->getId(),
                'stateMachineState.technicalName' => 'open',
            ],
            20,
            ['stateMachineState', 'lineItems']
        );

        $orders = $this->orderRepository->search($orderCriteria, $context);

        $quotes = [];
        foreach ($orders as $order) {
            $quotes[] = [
                'orderNumber' => $order->getOrderNumber(),
                'orderDate'   => $order->getOrderDateTime()?->format('Y-m-d H:i'),
                'total'       => $order->getAmountTotal(),
                'status'      => $order->getStateMachineState()?->getTechnicalName(),
                'lineItems'   => array_map(
                    fn ($item) => ['label' => $item->getLabel(), 'quantity' => $item->getQuantity(), 'price' => $item->getUnitPrice()],
                    iterator_to_array($order->getLineItems() ?? new \ArrayIterator())
                ),
            ];
        }

        return $quotes;
    }

    /**
     * Returns other customer accounts sharing the same company in the given sales channel.
     * Standard Shopware does not have B2B employee accounts natively; this returns
     * customers sharing the same company name as a proxy.
     */
    public function getEmployeeAccounts(string $email, string $salesChannelId, Context $context): array
    {
        // Find the requesting customer to get company name
        $customer = $this->findCustomerByEmail($email, $salesChannelId, $context);
        if ($customer === null || $customer->getCompany() === null || $customer->getCompany() === '') {
            return [];
        }

        // Find other customers with the same company
        $companyCriteria = CriteriaFactory::forEquals([
            'company' => $customer->getCompany(),
            'salesChannelId' => $salesChannelId,
        ], 50);

        $employees = [];
        foreach ($this->customerRepository->search($companyCriteria, $context) as $emp) {
            if ($emp->getId() === $customer->getId()) {
                continue; // Skip the requesting customer themselves
            }
            $employees[] = [
                'id'             => $emp->getId(),
                'email'          => $emp->getEmail(),
                'firstName'      => $emp->getFirstName(),
                'lastName'       => $emp->getLastName(),
                'customerNumber' => $emp->getCustomerNumber(),
            ];
        }

        return $employees;
    }

    private function findCustomerByEmail(string $email, string $salesChannelId, Context $context)
    {
        $criteria = CriteriaFactory::forEquals([
            'email' => $email,
            'salesChannelId' => $salesChannelId,
        ], 1);

        return $this->customerRepository->search($criteria, $context)->first();
    }
}
