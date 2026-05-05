<?php declare(strict_types=1);

$vendorAutoload = __DIR__ . '/../../../../vendor/autoload.php';
/** @var \Composer\Autoload\ClassLoader $loader */
$loader = require $vendorAutoload;
if ($loader instanceof \Composer\Autoload\ClassLoader) {
    $loader->addPsr4('Voltimax\\Chat\\', __DIR__ . '/../src/');
    $loader->addPsr4('Voltimax\\Chat\\Tests\\', __DIR__ . '/');
} else {
    // Already loaded — find the registered ClassLoader
    foreach (spl_autoload_functions() as $fn) {
        if (is_array($fn) && $fn[0] instanceof \Composer\Autoload\ClassLoader) {
            $fn[0]->addPsr4('Voltimax\\Chat\\', __DIR__ . '/../src/');
            $fn[0]->addPsr4('Voltimax\\Chat\\Tests\\', __DIR__ . '/');
            break;
        }
    }
}
