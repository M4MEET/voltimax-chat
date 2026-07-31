<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Service;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressCollection;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerAddress\CustomerAddressEntity;
use Shopware\Core\Checkout\Customer\Aggregate\CustomerGroup\CustomerGroupEntity;
use Shopware\Core\Checkout\Customer\CustomerEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Shopware\Core\System\Country\CountryEntity;
use Voltimax\Chat\Service\CustomerDataService;

class CustomerDataServiceTest extends TestCase
{
    private Context $context;

    protected function setUp(): void
    {
        $this->context = Context::createDefaultContext();
    }

    /** @param callable(Criteria):void|null $criteriaSpy */
    private function makeService(?CustomerEntity $customer, ?callable $criteriaSpy = null): CustomerDataService
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('first')->willReturn($customer);

        $repo = $this->createMock(EntityRepository::class);
        $repo->method('search')->willReturnCallback(
            function (Criteria $criteria) use ($result, $criteriaSpy) {
                if ($criteriaSpy !== null) {
                    $criteriaSpy($criteria);
                }
                return $result;
            }
        );

        return new CustomerDataService($repo);
    }

    private function makeCustomer(): CustomerEntity
    {
        $group = new CustomerGroupEntity();
        $group->setId('group-id');
        $group->setName('B2B');

        $billing = new CustomerAddressEntity();
        $billing->setId('billing-id');
        $billing->setCity('Berlin');

        $customer = new CustomerEntity();
        $customer->setId('customer-id');
        $customer->setEmail('jane@example.com');
        $customer->setFirstName('Jane');
        $customer->setLastName('Doe');
        $customer->setCustomerNumber('C-1000');
        $customer->setGroup($group);
        $customer->setCreatedAt(new \DateTimeImmutable('2024-03-01 12:30:00'));
        $customer->setDefaultBillingAddress($billing);

        return $customer;
    }

    public function testGetByEmailReturnsMappedCustomer(): void
    {
        $data = $this->makeService($this->makeCustomer())->getByEmail('jane@example.com', $this->context);

        static::assertSame([
            'id' => 'customer-id',
            'email' => 'jane@example.com',
            'firstName' => 'Jane',
            'lastName' => 'Doe',
            'customerNumber' => 'C-1000',
            'group' => 'B2B',
            'createdAt' => '2024-03-01',
            'city' => 'Berlin',
        ], $data);
    }

    public function testGetByEmailFiltersByEmailAndLimitsToOne(): void
    {
        $captured = null;
        $service = $this->makeService($this->makeCustomer(), function (Criteria $criteria) use (&$captured) {
            $captured = $criteria;
        });

        $service->getByEmail('jane@example.com', $this->context);

        static::assertNotNull($captured);
        static::assertSame(1, $captured->getLimit());
        static::assertContains('defaultBillingAddress', array_keys($captured->getAssociations()));
        static::assertStringContainsString('jane@example.com', json_encode($captured->getFilters()));
    }

    public function testGetByEmailReturnsNullWhenNotFound(): void
    {
        static::assertNull($this->makeService(null)->getByEmail('nobody@example.com', $this->context));
    }

    public function testGetByIdReturnsMappedCustomerWithoutAddress(): void
    {
        $data = $this->makeService($this->makeCustomer())->getById('customer-id', $this->context);

        static::assertSame('C-1000', $data['customerNumber']);
        static::assertSame('B2B', $data['group']);
        static::assertArrayNotHasKey('city', $data);
    }

    public function testGetByIdReturnsNullWhenNotFound(): void
    {
        static::assertNull($this->makeService(null)->getById('missing', $this->context));
    }

    public function testGetAddressesReturnsMappedAddresses(): void
    {
        $country = new CountryEntity();
        $country->setId('country-id');
        $country->setName('Germany');

        $address = new CustomerAddressEntity();
        $address->setId('address-id');
        $address->setFirstName('Jane');
        $address->setLastName('Doe');
        $address->setStreet('Hauptstr. 1');
        $address->setCity('Berlin');
        $address->setZipcode('10115');
        $address->setCountry($country);
        $address->setCompany('Voltimax');
        $address->setPhoneNumber('+49 30 123');

        $customer = $this->makeCustomer();
        $customer->setAddresses(new CustomerAddressCollection([$address]));

        $addresses = $this->makeService($customer)->getAddresses('jane@example.com', $this->context);

        static::assertCount(1, $addresses);
        static::assertSame([
            'id' => 'address-id',
            'firstName' => 'Jane',
            'lastName' => 'Doe',
            'street' => 'Hauptstr. 1',
            'city' => 'Berlin',
            'zipcode' => '10115',
            'country' => 'Germany',
            'company' => 'Voltimax',
            'phone' => '+49 30 123',
        ], $addresses[0]);
    }

    public function testGetAddressesReturnsEmptyArrayWhenCustomerMissing(): void
    {
        static::assertSame([], $this->makeService(null)->getAddresses('nobody@example.com', $this->context));
    }

    public function testGetAddressesReturnsEmptyArrayWhenCustomerHasNoAddresses(): void
    {
        static::assertSame([], $this->makeService($this->makeCustomer())->getAddresses('jane@example.com', $this->context));
    }
}
