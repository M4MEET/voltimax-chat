<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;

class CustomerDataService
{
    private EntityRepository $customerRepository;

    public function __construct(EntityRepository $customerRepository)
    {
        $this->customerRepository = $customerRepository;
    }

    public function getByEmail(string $email, Context $context): ?array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('email', $email));
        $criteria->addAssociation('defaultBillingAddress');
        $criteria->addAssociation('group');
        $criteria->setLimit(1);

        $customer = $this->customerRepository->search($criteria, $context)->first();
        if ($customer === null) {
            return null;
        }

        return [
            'id' => $customer->getId(),
            'email' => $customer->getEmail(),
            'firstName' => $customer->getFirstName(),
            'lastName' => $customer->getLastName(),
            'customerNumber' => $customer->getCustomerNumber(),
            'group' => $customer->getGroup()?->getName(),
            'createdAt' => $customer->getCreatedAt()?->format('Y-m-d'),
            'city' => $customer->getDefaultBillingAddress()?->getCity(),
        ];
    }

    public function getAddresses(string $email, Context $context): array
    {
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('email', $email));
        $criteria->addAssociation('addresses');
        $criteria->addAssociation('addresses.country');
        $criteria->setLimit(1);

        $customer = $this->customerRepository->search($criteria, $context)->first();
        if ($customer === null) {
            return [];
        }

        $addresses = [];
        foreach ($customer->getAddresses() ?? [] as $addr) {
            $addresses[] = [
                'id'        => $addr->getId(),
                'firstName' => $addr->getFirstName(),
                'lastName'  => $addr->getLastName(),
                'street'    => $addr->getStreet(),
                'city'      => $addr->getCity(),
                'zipcode'   => $addr->getZipcode(),
                'country'   => $addr->getCountry()?->getName(),
                'company'   => $addr->getCompany(),
                'phone'     => $addr->getPhoneNumber(),
            ];
        }
        return $addresses;
    }

    public function getById(string $id, Context $context): ?array
    {
        $criteria = new Criteria([$id]);
        $criteria->addAssociation('defaultBillingAddress');
        $criteria->addAssociation('group');

        $customer = $this->customerRepository->search($criteria, $context)->first();
        if ($customer === null) {
            return null;
        }

        return [
            'id' => $customer->getId(),
            'email' => $customer->getEmail(),
            'firstName' => $customer->getFirstName(),
            'lastName' => $customer->getLastName(),
            'customerNumber' => $customer->getCustomerNumber(),
            'group' => $customer->getGroup()?->getName(),
        ];
    }
}
