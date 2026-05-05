<?php declare(strict_types=1);

namespace Voltimax\Chat\Security;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Symfony\Component\HttpFoundation\Request;

class ApiKeyAuthenticator
{
    private const HEADER = 'X-Voltimax-Api-Key';

    private EntityRepository $integrationRepository;

    public function __construct(EntityRepository $integrationRepository)
    {
        $this->integrationRepository = $integrationRepository;
    }

    public function authenticate(Request $request): bool
    {
        $providedKey = $request->headers->get(self::HEADER);
        if (empty($providedKey)) {
            return false;
        }

        // Validate against a Shopware Integration (Settings → Integrations in admin).
        // Deleting an integration in the admin hard-deletes the row, so no soft-delete
        // check is needed — a deleted integration simply won't be found.
        $criteria = new Criteria();
        $criteria->addFilter(new EqualsFilter('accessKey', $providedKey));
        $criteria->setLimit(1);

        return $this->integrationRepository
            ->search($criteria, Context::createDefaultContext())
            ->count() > 0;
    }
}
