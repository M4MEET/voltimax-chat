<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Security;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Shopware\Core\System\Integration\IntegrationEntity;
use Symfony\Component\HttpFoundation\Request;
use Voltimax\Chat\Config\PluginConfig;
use Voltimax\Chat\Security\ApiKeyAuthenticator;

class ApiKeyAuthenticatorTest extends TestCase
{
    private function makeAuth(?IntegrationEntity $integration, bool $requireSecret = false): ApiKeyAuthenticator
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('first')->willReturn($integration);

        $repo = $this->createStub(EntityRepository::class);
        $repo->method('search')->willReturn($result);

        $config = $this->createStub(PluginConfig::class);
        $config->method('isApiSecretRequired')->willReturn($requireSecret);

        return new ApiKeyAuthenticator($repo, $config);
    }

    private function makeIntegration(string $secretHash = ''): IntegrationEntity
    {
        $integration = $this->createStub(IntegrationEntity::class);
        $integration->method('getSecretAccessKey')->willReturn($secretHash);
        return $integration;
    }

    public function testValidApiKeyInHeader(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'valid-integration-key');
        static::assertTrue($this->makeAuth($this->makeIntegration())->authenticate($request));
    }

    public function testInvalidApiKeyReturnsFalse(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'wrong-key');
        static::assertFalse($this->makeAuth(null)->authenticate($request));
    }

    public function testMissingApiKeyReturnsFalse(): void
    {
        $request = new Request();
        // Repo should not even be called — empty header short-circuits
        $repo = $this->createMock(EntityRepository::class);
        $repo->expects($this->never())->method('search');
        $config = $this->createStub(PluginConfig::class);
        static::assertFalse((new ApiKeyAuthenticator($repo, $config))->authenticate($request));
    }

    public function testValidSecretIsAccepted(): void
    {
        $hash = password_hash('the-real-secret', PASSWORD_DEFAULT);
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'valid-integration-key');
        $request->headers->set('X-Voltimax-Api-Secret', 'the-real-secret');
        static::assertTrue($this->makeAuth($this->makeIntegration($hash))->authenticate($request));
    }

    public function testWrongSecretIsRejectedEvenWithoutEnforcement(): void
    {
        $hash = password_hash('the-real-secret', PASSWORD_DEFAULT);
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'valid-integration-key');
        $request->headers->set('X-Voltimax-Api-Secret', 'wrong-secret');
        static::assertFalse($this->makeAuth($this->makeIntegration($hash))->authenticate($request));
    }

    public function testMissingSecretRejectedWhenEnforced(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'valid-integration-key');
        static::assertFalse(
            $this->makeAuth($this->makeIntegration(password_hash('s', PASSWORD_DEFAULT)), true)->authenticate($request)
        );
    }

    public function testLegacyKeyOnlyStillWorksWhenNotEnforced(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'valid-integration-key');
        static::assertTrue(
            $this->makeAuth($this->makeIntegration(password_hash('s', PASSWORD_DEFAULT)), false)->authenticate($request)
        );
    }
}
