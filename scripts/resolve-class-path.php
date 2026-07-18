<?php

require 'vendor/autoload.php';

$class = trim($argv[1] ?? '', " \t\r\n\\");

if ($class === '' || !preg_match('/^[A-Za-z_][A-Za-z0-9_]*(?:\\\\[A-Za-z_][A-Za-z0-9_]*)*$/', $class)) {
    exit(1);
}

try {
    $file = (new ReflectionClass($class))->getFileName();

    if ($file === false) {
        exit(1);
    }

    echo $file;
} catch (Throwable) {
    exit(1);
}
