<?php

require 'vendor/autoload.php';

$app = require 'bootstrap/app.php';
$app->make('Illuminate\\Contracts\\Console\\Kernel')->bootstrap();

$compiler = app('blade.compiler');

function sourcePosition(string $source, int $offset): array
{
    $prefix = substr($source, 0, $offset);
    $line = substr_count($prefix, "\n");
    $lineStart = strrpos($prefix, "\n");
    $columnText = substr($prefix, $lineStart === false ? 0 : $lineStart + 1);
    preg_match_all('/./us', $columnText, $characters);
    $column = 0;

    foreach ($characters[0] as $character) {
        $column += strlen($character) === 4 ? 2 : 1;
    }

    return [$line, $column];
}

function marker(string $kind, string $phase, string $source, int $start, int $end, string $style): string
{
    [$startLine, $startColumn] = sourcePosition($source, $start);
    [$endLine, $endColumn] = sourcePosition($source, $end);
    $value = "blade-complete:{$kind}:{$phase}:{$startLine}:{$startColumn}:{$endLine}:{$endColumn}";

    return $style === 'html' ? "<!-- {$value} -->" : " /* {$value} */";
}

function matchingParen(string $value, int $open): ?int
{
    $depth = 0;
    $quote = null;
    $length = strlen($value);

    for ($i = $open; $i < $length; $i++) {
        $char = $value[$i];

        if ($quote !== null) {
            if ($char === '\\') {
                $i++;
            } elseif ($char === $quote) {
                $quote = null;
            }

            continue;
        }

        if ($char === "'" || $char === '"') {
            $quote = $char;
        } elseif ($char === '(') {
            $depth++;
        } elseif ($char === ')' && --$depth === 0) {
            return $i;
        }
    }

    return null;
}

function findValueEnd(string $source, int $valueStart, int $close): int
{
    $depth = 0;
    $inString = null;
    $valueEnd = $valueStart;

    for ($i = $valueStart; $i < $close; $i++) {
        $char = $source[$i];

        if ($inString !== null) {
            if ($char === '\\') {
                $i++;
            } elseif ($char === $inString) {
                $inString = null;
            }

            continue;
        }

        if ($char === "'" || $char === '"') {
            $inString = $char;
        } elseif ($char === '[' || $char === '(' || $char === '{') {
            $depth++;
        } elseif ($char === ']' || $char === ')' || $char === '}') {
            if ($depth === 0) {
                return $i;
            }

            $depth--;
        } elseif ($char === ',' && $depth === 0) {
            return $i;
        }
    }

    return $valueEnd;
}

// Escape-aware scan for the quote closing a string at $open — strpos would
// stop at an escaped quote (e.g. 'it\'s') and truncate the key.
function findClosingQuote(string $source, int $open, string $quote): int
{
    for ($i = $open + 1; $i < strlen($source); $i++) {
        if ($source[$i] === '\\') {
            $i++;
        } elseif ($source[$i] === $quote) {
            return $i;
        }
    }

    return -1;
}

// Balanced-bracket/quote check for prop values copied into the generated PHP
// prelude. A value captured mid-typing (e.g. `collect([1, 2`) would emit an
// unparseable prelude line and poison intelephense analysis for the file.
function isBalancedExpression(string $value): bool
{
    $depth = 0;
    $quote = null;
    $length = strlen($value);

    for ($i = 0; $i < $length; $i++) {
        $char = $value[$i];

        if ($quote !== null) {
            if ($char === '\\') {
                $i++;
            } elseif ($char === $quote) {
                $quote = null;
            }

            continue;
        }

        if ($char === "'" || $char === '"') {
            $quote = $char;
        } elseif ($char === '[' || $char === '(' || $char === '{') {
            $depth++;
        } elseif ($char === ']' || $char === ')' || $char === '}') {
            if ($depth === 0) {
                return false;
            }

            $depth--;
        }
    }

    return $depth === 0 && $quote === null;
}

function propTypes(string $source): array
{
    $props = [];

    if (!preg_match_all('/@props\s*\(/i', $source, $directives, PREG_OFFSET_CAPTURE)) {
        return $props;
    }

    foreach ($directives[0] as $directive) {
        $open = $directive[1] + strlen($directive[0]) - 1;
        $close = matchingParen($source, $open);

        if ($close === null) {
            continue;
        }

        $arrayStart = strpos($source, '[', $open + 1);

        if ($arrayStart === false || $arrayStart > $close) {
            continue;
        }

        // Scan prop keys at depth 1, mirroring extractPropsFromExpression in
        // src/libs/blade-string.ts so both sides agree on nested values.
        $depth = 0;
        $quote = null;
        $length = strlen($source);

        for ($i = $arrayStart; $i < $close; $i++) {
            $char = $source[$i];

            if ($quote !== null) {
                if ($char === '\\') {
                    $i++;
                } elseif ($char === $quote) {
                    $quote = null;
                }

                continue;
            }

            if ($char !== "'" && $char !== '"') {
                if ($char === '[' || $char === '(' || $char === '{') {
                    $depth++;
                } elseif ($char === ']' || $char === ')' || $char === '}') {
                    $depth--;
                }

                continue;
            }

            $previous = '';
            for ($j = $i - 1; $j >= 0; $j--) {
                if (!ctype_space($source[$j])) {
                    $previous = $source[$j];
                    break;
                }
            }
            $isPropKey = $depth === 1 && ($previous === '[' || $previous === ',');
            $quote = $char;

            if (!$isPropKey) {
                continue;
            }

            $end = findClosingQuote($source, $i, $char);

            if ($end === -1 || $end >= $close) {
                break;
            }

            $name = substr($source, $i + 1, $end - $i - 1);
            $next = ltrim(substr($source, $end + 1, $close - $end - 1));

            if (str_starts_with($next, '=>')) {
                $arrowOffset = strpos($source, '=>', $end + 1);
                $valueStart = $arrowOffset + 2;
                $valueEnd = findValueEnd($source, $valueStart, $close);
                $props[$name] = trim(substr($source, $valueStart, $valueEnd - $valueStart));
                $i = max($end, $valueEnd - 1);
            } elseif (str_starts_with($next, ',') || str_starts_with($next, ']')) {
                $i = $end;
            } else {
                break;
            }

            $quote = null;
        }
    }

    return $props;
}

function componentTagEnd(string $value, int $start): ?int
{
    $quote = null;
    $length = strlen($value);

    for ($i = $start; $i < $length; $i++) {
        $char = $value[$i];

        if ($quote !== null) {
            if ($char === '\\') {
                $i++;
            } elseif ($char === $quote) {
                $quote = null;
            }

            continue;
        }

        if ($char === "'" || $char === '"') {
            $quote = $char;
        } elseif ($char === '{' && $i + 1 < $length && ($value[$i + 1] === '{' || $value[$i + 1] === '!')) {
            // Skip Blade echo expressions — the `>` inside `{{ $foo->bar }}`
            // or `{!! $foo->bar !!}` must not be mistaken for the tag-closing `>`.
            $closeSeq = $value[$i + 1] === '!' ? '!!}' : '}}';
            $close = strpos($value, $closeSeq, $i + 2);

            if ($close === false) {
                return null;
            }

            $i = $close + strlen($closeSeq) - 1;
        } elseif ($char === '>') {
            return $i + 1;
        }
    }

    return null;
}

function addExpressionMarkers(string $source, array &$insertions, string $pattern, ?string $scan = null): void
{
    $scan ??= $source;

    if (!preg_match_all($pattern, $scan, $matches, PREG_OFFSET_CAPTURE)) {
        return;
    }

    foreach ($matches[0] as $index => $match) {
        $expression = $matches[1][$index][0];
        $expressionStart = $matches[1][$index][1];
        $trimmed = trim($expression);
        $leftTrim = strlen($expression) - strlen(ltrim($expression));
        $start = $expressionStart + $leftTrim;
        $end = $start + strlen($trimmed);

        if ($trimmed === '') {
            continue;
        }

        $insertions[] = ['offset' => $start, 'text' => marker('expression', 'start', $source, $start, $end, 'php')];
        $insertions[] = ['offset' => $end, 'text' => marker('expression', 'end', $source, $start, $end, 'php')];
    }
}

function maskBladeComments(string $source, array &$insertions): string
{
    $scan = $source;

    // Match every blade comment. Plain comments are discarded (masked to
    // whitespace so positions stay aligned); only `@var`/`@see` comments are
    // kept, converted to a php docblock intelephense can resolve.
    if (!preg_match_all('/\{\{\-\-[\s\S]*?\-\-\}\}/', $source, $comments, PREG_OFFSET_CAPTURE)) {
        return $scan;
    }

    foreach ($comments[0] as $comment) {
        $value = $comment[0];
        $start = (int) $comment[1];
        $end = $start + strlen($value);

        if (preg_match('/^\s*@(var|see)\b(.*)$/is', substr($value, 4, -4), $docblock) === 1) {
            $insertions[] = [
                'offset' => $start,
                'length' => strlen($value),
                'text'   => '<?php'
                    . marker('expression', 'start', $source, $start, $end, 'php')
                    . " /** @{$docblock[1]} " . trim($docblock[2]) . ' */'
                    . marker('expression', 'end', $source, $start, $end, 'php')
                    . ' ?>',
            ];
        }

        $masked = preg_replace_callback('/[^\r\n]/u', fn ($character) => str_repeat(' ', strlen($character[0])), $value);
        $scan = substr_replace($scan, $masked, $start, strlen($value));
    }

    return $scan;
}

function wrapHtmlExpressions(string $compiled): string
{
    $phpRanges = [];

    if (preg_match_all('/<\?(?:php|=)(?:(?!\?>).)*\?>/is', $compiled, $blocks, PREG_OFFSET_CAPTURE)) {
        foreach ($blocks[0] as $block) {
            $phpRanges[] = [(int) $block[1], (int) $block[1] + strlen($block[0])];
        }
    }

    if (!preg_match_all('/\/\*\s*blade-complete:expression:(start|end):\d+:\d+:\d+:\d+\s*\*\//', $compiled, $matches, PREG_OFFSET_CAPTURE)) {
        if (preg_match_all('/\/\*\s*blade-complete:/', $compiled, $partialMatches)) {
            fwrite(STDERR, "wrapHtmlExpressions: found blade-complete comments but none matched expression pattern\n");
        }

        return $compiled;
    }

    $pairs = [];
    $open = null;

    foreach ($matches[0] as $index => $match) {
        $offset = (int) $match[1];
        $phase = $matches[1][$index][0];
        $length = strlen($match[0]);

        if ($phase === 'start') {
            $open = [$offset, $length];
        } elseif ($open !== null) {
            $pairs[] = [$open[0], $open[1], $offset, $length];
            $open = null;
        }
    }

    $isInPhp = function (int $offset) use ($phpRanges): bool {
        foreach ($phpRanges as [$start, $end]) {
            if ($offset >= $start && $offset <= $end) {
                return true;
            }
        }

        return false;
    };

    $insertions = [];

    foreach ($pairs as [$start, $startLength, $end, $endLength]) {
        if ($isInPhp($start)) {
            continue;
        }

        // skip uncompiled blade delimiters left in the output (e.g. `{{ ... }}` inside @verbatim)
        $before = rtrim(substr($compiled, 0, $start));
        $after = ltrim(substr($compiled, $end + $endLength));
        $prevChar = $before === '' ? '' : substr($before, -1);
        $nextChar = $after === '' ? '' : $after[0];

        if ($prevChar === '{' || $nextChar === '}') {
            continue;
        }

        $insertions[] = ['offset' => $start, 'text' => '<?php'];
        $insertions[] = ['offset' => $end + $endLength, 'text' => ' ?>'];
    }

    if ($insertions === []) {
        return $compiled;
    }

    usort($insertions, fn ($left, $right) => $right['offset'] <=> $left['offset']);

    foreach ($insertions as $insertion) {
        $compiled = substr_replace($compiled, $insertion['text'], $insertion['offset'], 0);
    }

    return $compiled;
}

$markSource = function ($value) use ($refPattern) {
    $insertions = [];
    $source = $value;
    $value = maskBladeComments($source, $insertions);
    $phpRanges = [];

    if (preg_match_all('/@php\b(.*?)@endphp\b/is', $value, $blocks, PREG_OFFSET_CAPTURE)) {
        foreach ($blocks[1] as $block) {
            $start = (int) $block[1];
            $phpRanges[] = [$start, $start + strlen($block[0])];
        }
    }

    $isInPhpBlock = function (int $offset) use ($phpRanges): bool {
        foreach ($phpRanges as [$start, $end]) {
            if ($offset >= $start && $offset <= $end) {
                return true;
            }
        }

        return false;
    };

    if (preg_match_all('/<\s*(x[-:][\w\-:.]*|[a-z][\w-]*:[\w\-:.]*)\b|<\s*(\/(?:x[-:][\w\-:.]*|[a-z][\w-]*:[\w\-:.]*))\b/i', $value, $matches, PREG_OFFSET_CAPTURE)) {
        foreach ($matches[0] as $match) {
            $start = (int) $match[1];
            $end = componentTagEnd($value, $start);

            if ($end === null) {
                continue;
            }

            $isClosing = str_starts_with(ltrim($match[0]), '</');
            $kind = $isClosing ? 'component-close' : 'component';
            $startMarker = marker($kind, 'start', $source, $start, $end, 'html');
            $endMarker = marker($kind, 'end', $source, $start, $end, 'html');
            $insertions[] = ['offset' => $start, 'text' => $startMarker];
            $insertions[] = ['offset' => $end, 'text' => $endMarker];

            if ($isClosing) {
                continue;
            }

            $tag = substr($value, $start, $end - $start);

            if (preg_match_all('/(?:^|\s)(:[\w\-:.@]+)\s*=\s*(["\'])(.*?)\2/s', $tag, $attributes, PREG_OFFSET_CAPTURE)) {
                foreach ($attributes[3] as $attribute) {
                    $expression = trim($attribute[0]);

                    if ($expression === '') {
                        continue;
                    }

                    $attributeStart = $start + $attribute[1];
                    $leftTrim = strlen($attribute[0]) - strlen(ltrim($attribute[0]));
                    $expressionStart = $attributeStart + $leftTrim;
                    $expressionEnd = $expressionStart + strlen($expression);
                    $insertions[] = [
                        'offset' => $expressionStart,
                        'text'   => marker('expression', 'start', $source, $expressionStart, $expressionEnd, 'php'),
                    ];
                    $insertions[] = [
                        'offset' => $expressionEnd,
                        'text'   => marker('expression', 'end', $source, $expressionStart, $expressionEnd, 'php'),
                    ];
                }
            }
        }
    }

    addExpressionMarkers($source, $insertions, '/\{\{\{\s*(.*?)\s*\}\}\}/s', $value);
    addExpressionMarkers($source, $insertions, '/\{\{(?!\{)\-?\s*(.*?)\s*\-?\}\}(?!\})/s', $value);
    addExpressionMarkers($source, $insertions, '/\{!!\s*(.*?)\s*!!\}/s', $value);

    if (preg_match_all('/@[A-Za-z_]\w*\s*\(/', $value, $directives, PREG_OFFSET_CAPTURE)) {
        foreach ($directives[0] as $directive) {
            if ($isInPhpBlock((int) $directive[1])) {
                continue;
            }

            $open = strpos($directive[0], '(');
            $open += $directive[1];
            $close = matchingParen($value, $open);

            if ($close === null) {
                continue;
            }

            $argument = substr($value, $open + 1, $close - $open - 1);
            $trimmed = trim($argument);

            if ($trimmed === '') {
                continue;
            }

            if (preg_match($refPattern, $directive[0])) {
                $argumentStart = $open + 1 + (strlen($argument) - strlen(ltrim($argument)));
                $pathStart = 0;
                $path = $trimmed;

                if (str_starts_with($path, 'function ') || str_starts_with($path, 'const ')) {
                    $pathStart = strpos($path, ' ') + 1;
                }

                $quote = $path[$pathStart] ?? '';
                $pathStart += $quote === "'" || $quote === '"' ? 1 : 0;
                $pathStart += strspn($path, " \t\r\n", $pathStart);
                $pathEnd = $quote === "'" || $quote === '"'
                    ? strpos($path, $quote, $pathStart)
                    : strpos($path, ',');
                $pathEnd = $pathEnd === false ? strlen($path) : $pathEnd;

                while ($pathEnd > $pathStart && str_contains(" \t\r\n", $path[$pathEnd - 1])) {
                    $pathEnd--;
                }

                $argumentStart += $pathStart;
                $argumentEnd = $argumentStart + $pathEnd - $pathStart;

                $directiveStart = (int) $directive[1];
                $directiveEnd = $close + 1;
                $isProps = str_starts_with(strtolower($directive[0]), '@props');
                $markerStart = $isProps ? $directiveStart : $argumentStart;
                $markerEnd = $isProps ? $directiveStart + strlen('@props') : $argumentEnd;
                $insertions[] = ['offset' => $directiveStart, 'text' => marker('cursor', 'start', $source, $markerStart, $markerEnd, 'php')];
                $insertions[] = ['offset' => $directiveEnd, 'text' => marker('cursor', 'end', $source, $markerStart, $markerEnd, 'php')];
            } else {
                $leftTrim = strlen($argument) - strlen(ltrim($argument));
                $start = $open + 1 + $leftTrim;
                $end = $start + strlen($trimmed);
                $insertions[] = ['offset' => $start, 'text' => marker('directive', 'start', $source, $start, $end, 'php')];
                $insertions[] = ['offset' => $end, 'text' => marker('directive', 'end', $source, $start, $end, 'php')];
            }
        }
    }

    if (preg_match_all('/@\w+(?=[\s(]|$)/', $value, $directives, PREG_OFFSET_CAPTURE)) {
        foreach ($directives[0] as $directive) {
            if ($isInPhpBlock((int) $directive[1])) {
                continue;
            }

            $name = strtolower(substr($directive[0], 1));

            if ($name === 'php' || $name === 'endphp') {
                continue;
            }

            $start = $directive[1];
            $end = $start + strlen($directive[0]);

            if (preg_match('/^\s*\(/', substr($value, $end))) {
                continue;
            }

            $insertions[] = ['offset' => $start, 'text' => marker('directive', 'start', $source, $start, $end, 'html')];
            $insertions[] = ['offset' => $end, 'text' => marker('directive', 'end', $source, $start, $end, 'html')];
        }
    }

    if (preg_match_all('/@php\b(.*?)@endphp\b/is', $value, $blocks, PREG_OFFSET_CAPTURE)) {
        foreach ($blocks[1] as $block) {
            $start = (int) $block[1];
            $end = $start + strlen($block[0]);
            $insertions[] = ['offset' => $start, 'text' => marker('php', 'start', $source, $start, $end, 'php')];
            $insertions[] = ['offset' => $end, 'text' => marker('php', 'end', $source, $start, $end, 'php')];
        }
    }

    if (preg_match_all('/<\?php\b(.*?)\?>/is', $value, $blocks, PREG_OFFSET_CAPTURE)) {
        foreach ($blocks[1] as $block) {
            $start = (int) $block[1];
            $end = $start + strlen($block[0]);
            $insertions[] = ['offset' => $start, 'text' => marker('php', 'start', $source, $start, $end, 'php')];
            $insertions[] = ['offset' => $end, 'text' => marker('php', 'end', $source, $start, $end, 'php')];
        }
    }

    usort($insertions, fn ($left, $right) => $right['offset'] <=> $left['offset']);

    foreach ($insertions as $insertion) {
        $value = substr_replace($value, $insertion['text'], $insertion['offset'], $insertion['length'] ?? 0);
    }

    return $value;
};

try {
    $callbacks = (new ReflectionProperty($compiler, 'prepareStringsForCompilationUsing'))->getValue($compiler);
    (new ReflectionProperty($compiler, 'prepareStringsForCompilationUsing'))->setValue($compiler, array_merge([$markSource], $callbacks));
} catch (ReflectionException $e) {
    fwrite(STDERR, 'blade-complete: prepareStringsForCompilationUsing reflection failed, markers disabled: ' . $e->getMessage() . "\n");
}

$input = stream_get_contents(STDIN);

if ($input === false || $input === '') {
    fwrite(STDERR, 'No input provided');
    exit(1);
}

$items = json_decode($input, true);

if (!is_array($items)) {
    fwrite(STDERR, 'Invalid JSON input');
    exit(1);
}

$results = [];

foreach ($items as $item) {
    try {
        $compiled = wrapHtmlExpressions($compiler->compileString($item['content']));
        $output = "<?php\n";
        foreach ($item['phpDefaultImports'] ?? [] as $import) {
            $output .= "use {$import};\n";
        }
        foreach ($item['phpDocBlocks'] ?? $phpDocBlocks as $block) {
            $block = str_replace('*/', '*\\/', $block);
            $output .= "/** @var {$block} */\n";

            if (preg_match('/^(\S+)\s+(\$\w+)\s*(.*)$/s', $block, $m)) {
                $assignment = match ($m[1]) {
                    'string' => "{$m[2]} = " . var_export($m[3], true) . ';',
                    'int' => "{$m[2]} = " . (int) $m[3] . ';',
                    'float' => "{$m[2]} = " . (float) $m[3] . ';',
                    'bool' => "{$m[2]} = " . ($m[3] === '1' || strtolower($m[3]) === 'true' ? 'true' : 'false') . ';',
                    'null' => "{$m[2]} = null;",
                    'mixed' => "{$m[2]};",
                    default => '',
                };
                if ($assignment !== '') {
                    $output .= $assignment . "\n";
                }
            }
        }
        foreach (propTypes($item['content']) as $name => $value) {
            // Non-identifier or empty values would emit a PHP parse error in
            // the prelude (e.g. $foo-bar = 1;) — skip them instead.
            if (!preg_match('/^[A-Za-z_]\w*$/', $name) || $value === '' || !isBalancedExpression($value)) {
                continue;
            }

            $output .= "\${$name} = {$value};\n";
        }
        $output .= "?>\n" . $compiled;
        $results[] = ['id' => $item['id'], 'compiled' => $output];
    } catch (\Throwable $e) {
        fwrite(STDERR, "compile failed for {$item['path']}: {$e->getMessage()}\n");
    }
}

echo json_encode($results);
