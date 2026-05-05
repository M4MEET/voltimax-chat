<?php declare(strict_types=1);

namespace Voltimax\Chat\Migration;

use Doctrine\DBAL\Connection;
use Shopware\Core\Framework\Migration\MigrationStep;

class Migration1713225600CreateConsentLog extends MigrationStep
{
    public function getCreationTimestamp(): int
    {
        return 1713225600;
    }

    public function update(Connection $connection): void
    {
        $connection->executeStatement('
            CREATE TABLE IF NOT EXISTS `voltimax_chat_consent_log` (
                `id` BINARY(16) NOT NULL,
                `customer_email` VARCHAR(255) NOT NULL,
                `customer_name` VARCHAR(255) NOT NULL,
                `ip_address` VARCHAR(45) NOT NULL,
                `consented_at` DATETIME(3) NOT NULL,
                `sales_channel_id` BINARY(16) NULL,
                `created_at` DATETIME(3) NOT NULL,
                `updated_at` DATETIME(3) NULL,
                PRIMARY KEY (`id`),
                INDEX `idx_email` (`customer_email`),
                INDEX `idx_consented_at` (`consented_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ');
    }

    public function updateDestructive(Connection $connection): void
    {
    }
}
