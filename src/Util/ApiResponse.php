<?php declare(strict_types=1);

namespace Voltimax\Chat\Util;

use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

/**
 * Factories for the `{"error": "..."}` payloads shared by all Voltimax endpoints.
 */
final class ApiResponse
{
    public static function error(string $message, int $status): JsonResponse
    {
        return new JsonResponse(['error' => $message], $status);
    }

    public static function unauthorized(): JsonResponse
    {
        return self::error('Unauthorized', Response::HTTP_UNAUTHORIZED);
    }

    public static function notFound(): JsonResponse
    {
        return self::error('Not found', Response::HTTP_NOT_FOUND);
    }

    public static function badRequest(string $message): JsonResponse
    {
        return self::error($message, Response::HTTP_BAD_REQUEST);
    }

    public static function forbidden(string $message): JsonResponse
    {
        return self::error($message, Response::HTTP_FORBIDDEN);
    }

    public static function unprocessable(string $message): JsonResponse
    {
        return self::error($message, Response::HTTP_UNPROCESSABLE_ENTITY);
    }

    public static function chatDisabled(): JsonResponse
    {
        return self::error('Chat disabled', Response::HTTP_SERVICE_UNAVAILABLE);
    }

    public static function tooManyRequests(string $message): JsonResponse
    {
        return self::error($message, Response::HTTP_TOO_MANY_REQUESTS);
    }

    /**
     * Serialises the payload, or a 404 when the lookup produced nothing.
     */
    public static function dataOrNotFound(?array $data): JsonResponse
    {
        return $data === null ? self::notFound() : new JsonResponse($data);
    }
}
