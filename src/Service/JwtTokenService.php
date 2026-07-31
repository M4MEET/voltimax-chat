<?php declare(strict_types=1);

namespace Voltimax\Chat\Service;

use DateTimeImmutable;
use DateTimeZone;
use Lcobucci\Clock\SystemClock;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer\Hmac\Sha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use Lcobucci\JWT\Validation\Constraint\SignedWith;
use Lcobucci\JWT\Validation\Constraint\StrictValidAt;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use Voltimax\Chat\Config\PluginConfig;

class JwtTokenService
{
    private ?PluginConfig $config;
    private ?string $secret;
    private ?int $ttlSeconds;
    private LoggerInterface $logger;

    public function __construct(
        PluginConfig|string $secretOrConfig,
        ?int $ttlSeconds = null,
        ?LoggerInterface $logger = null
    ) {
        if ($secretOrConfig instanceof PluginConfig) {
            $this->config     = $secretOrConfig;
            $this->secret     = null;
            $this->ttlSeconds = null;
        } else {
            $this->config     = null;
            $this->secret     = $secretOrConfig;
            $this->ttlSeconds = $ttlSeconds ?? 1800;
        }
        $this->logger = $logger ?? new NullLogger();
    }

    public function setLogger(LoggerInterface $logger): void
    {
        $this->logger = $logger;
    }

    public function create(array $payload): string
    {
        $cfg = $this->buildConfig();
        $now = new DateTimeImmutable();
        $exp = $now->modify('+' . $this->getTtl() . ' seconds');

        $builder = $cfg->builder()
            ->issuedAt($now)
            ->canOnlyBeUsedAfter($now)
            ->expiresAt($exp);

        foreach ($payload as $key => $value) {
            $builder = $builder->withClaim($key, $value);
        }

        return $builder->getToken($cfg->signer(), $cfg->signingKey())->toString();
    }

    public function validate(string $token): ?array
    {
        $cfg = $this->buildConfig();

        try {
            $parsed = $cfg->parser()->parse($token);
        } catch (\Throwable $e) {
            // Malformed token — reject, but leave a trail for diagnosing
            // client/config issues (kept at debug: bad tokens are expected input).
            $this->logger->debug('VoltimaxChat: JWT parse failed', ['exception' => $e]);
            return null;
        }

        $clock = new SystemClock(new DateTimeZone('UTC'));
        $valid = $cfg->validator()->validate(
            $parsed,
            new SignedWith($cfg->signer(), $cfg->signingKey()),
            new StrictValidAt($clock),
        );

        if (!$valid) {
            $this->logger->debug('VoltimaxChat: JWT signature/expiry validation failed');
            return null;
        }

        // Return all claims as an array
        $claims = $parsed->claims();
        $result = [];
        foreach (['email', 'name', 'customer_id', 'has_orders', 'is_b2b'] as $key) {
            if ($claims->has($key)) {
                $result[$key] = $claims->get($key);
            }
        }
        // Include standard claims
        $result['iat'] = $claims->get(\Lcobucci\JWT\Token\RegisteredClaims::ISSUED_AT)?->getTimestamp();
        $result['exp'] = $claims->get(\Lcobucci\JWT\Token\RegisteredClaims::EXPIRATION_TIME)?->getTimestamp();

        return $result;
    }

    private function buildConfig(): Configuration
    {
        return Configuration::forSymmetricSigner(
            new Sha256(),
            InMemory::plainText($this->getSecret()),
        );
    }

    private function getSecret(): string
    {
        $secret = $this->secret ?? ($this->config?->getJwtSecret() ?? '');
        if ($secret === '') {
            throw new \RuntimeException('VoltimaxChat: JWT secret is not configured. Set it in plugin settings.');
        }
        return $secret;
    }

    private function getTtl(): int
    {
        return $this->ttlSeconds ?? ($this->config?->getJwtTtlSeconds() ?? 1800);
    }
}
