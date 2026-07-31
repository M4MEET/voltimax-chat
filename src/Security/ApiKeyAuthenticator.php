<?php declare(strict_types=1);

namespace Voltimax\Chat\Security;

use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Symfony\Component\HttpFoundation\Request;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Util\CriteriaFactory;

class ApiKeyAuthenticator
{
    private const HEADER = 'X-Voltimax-Api-Key';
    private const SECRET_HEADER = 'X-Voltimax-Api-Secret';

    private EntityRepository $integrationRepository;
    private PluginConfig $config;

    public function __construct(EntityRepository $integrationRepository, PluginConfig $config)
    {
        $this->integrationRepository = $integrationRepository;
        $this->config = $config;
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
        $criteria = CriteriaFactory::forEquals(['accessKey' => $providedKey], 1);

        $integration = $this->integrationRepository
            ->search($criteria, Context::createDefaultContext())
            ->first();

        if ($integration === null) {
            return false;
        }

        // The access key alone is not a secret (it is visible in the admin and
        // in requests). When the caller also presents the integration's SECRET
        // key, verify it against the stored hash. With requireApiSecret enabled
        // the secret becomes mandatory — access-key-only callers are rejected.
        $providedSecret = $request->headers->get(self::SECRET_HEADER);
        $storedHash = method_exists($integration, 'getSecretAccessKey')
            ? $integration->getSecretAccessKey()
            : null;

        if (!empty($providedSecret) && !empty($storedHash)) {
            return password_verify($providedSecret, $storedHash);
        }

        if ($this->config->isApiSecretRequired()) {
            return false; // secret missing (or unreadable) while enforcement is on
        }

        return true; // legacy mode: access key only
    }
}
