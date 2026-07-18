<?php

$data = [];
$excluded = ['app', '__env'];

$factory = app('view');

foreach ($bladeCompleteViews as $id => $name) {
    try {
        $view = $factory->make($name);
        $factory->callComposer($view);
        $values = array_merge($factory->getShared(), $view->getData());

        foreach ($values as $key => $value) {
            if (!in_array($key, $excluded, true) && is_string($key) && preg_match('/^[A-Za-z_]\w*$/', $key)) {
                $type = is_object($value) ? '\\' . get_class($value) : get_debug_type($value);
                $type = $type == 'null' ? 'mixed' : $type;
                $value = match (true) {
                    is_null($value) => 'null',
                    is_bool($value) => $value ? 'true' : 'false',
                    is_string($value) => var_export($value, true),
                    is_int($value), is_float($value) => (string) $value,
                    // Non-scalars (objects, arrays) get no prelude value — the
                    // compile script only assigns scalars, and interpolating an
                    // object here would throw and drop the whole view's data.
                    default         => '',
                };

                $data[$id][] = "{$type} \${$key} {$value}";
            }
        }
    } catch (Throwable $error) {
        fwrite(STDERR, "blade view data {$name}: {$error->getMessage()}\n");
        $data[$id] = [];
    }
}

echo '__BLADE_COMPLETE_VIEW_DATA__' . base64_encode(json_encode($data));
