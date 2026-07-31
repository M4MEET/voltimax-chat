<?php declare(strict_types=1);

namespace Voltimax\Chat\Tests\Unit\Util;

use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpFoundation\Response;
use Voltimax\Chat\Util\ApiResponse;

class ApiResponseTest extends TestCase
{
    public function testErrorsUseTheSharedPayloadShape(): void
    {
        $response = ApiResponse::forbidden("Scope 'orders' is disabled");

        static::assertSame(Response::HTTP_FORBIDDEN, $response->getStatusCode());
        static::assertSame(['error' => "Scope 'orders' is disabled"], json_decode((string) $response->getContent(), true));
    }

    public function testStatusCodesPerHelper(): void
    {
        static::assertSame(Response::HTTP_UNAUTHORIZED, ApiResponse::unauthorized()->getStatusCode());
        static::assertSame(Response::HTTP_NOT_FOUND, ApiResponse::notFound()->getStatusCode());
        static::assertSame(Response::HTTP_BAD_REQUEST, ApiResponse::badRequest('nope')->getStatusCode());
        static::assertSame(Response::HTTP_UNPROCESSABLE_ENTITY, ApiResponse::unprocessable('nope')->getStatusCode());
        static::assertSame(Response::HTTP_SERVICE_UNAVAILABLE, ApiResponse::chatDisabled()->getStatusCode());
        static::assertSame(Response::HTTP_TOO_MANY_REQUESTS, ApiResponse::tooManyRequests('slow down')->getStatusCode());
    }

    public function testDataOrNotFound(): void
    {
        $found = ApiResponse::dataOrNotFound(['id' => 'abc']);
        static::assertSame(Response::HTTP_OK, $found->getStatusCode());
        static::assertSame(['id' => 'abc'], json_decode((string) $found->getContent(), true));

        static::assertSame(Response::HTTP_NOT_FOUND, ApiResponse::dataOrNotFound(null)->getStatusCode());
    }
}
