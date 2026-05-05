<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Security;

use PHPUnit\Framework\TestCase;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\EntitySearchResult;
use Symfony\Component\HttpFoundation\Request;
use Voltimax\Chat\Security\ApiKeyAuthenticator;

class ApiKeyAuthenticatorTest extends TestCase
{
    private function makeAuth(int $matchCount): ApiKeyAuthenticator
    {
        $result = $this->createStub(EntitySearchResult::class);
        $result->method('count')->willReturn($matchCount);

        $repo = $this->createStub(EntityRepository::class);
        $repo->method('search')->willReturn($result);

        return new ApiKeyAuthenticator($repo);
    }

    public function testValidApiKeyInHeader(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'valid-integration-key');
        static::assertTrue($this->makeAuth(1)->authenticate($request));
    }

    public function testInvalidApiKeyReturnsFalse(): void
    {
        $request = new Request();
        $request->headers->set('X-Voltimax-Api-Key', 'wrong-key');
        static::assertFalse($this->makeAuth(0)->authenticate($request));
    }

    public function testMissingApiKeyReturnsFalse(): void
    {
        $request = new Request();
        // Repo should not even be called — empty header short-circuits
        $repo = $this->createMock(EntityRepository::class);
        $repo->expects($this->never())->method('search');
        static::assertFalse((new ApiKeyAuthenticator($repo))->authenticate($request));
    }
}
