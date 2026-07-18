# Blade Parser

VS Code extension that brings language intelligence to Laravel Blade templates (`.blade.php`).

## Requirements

- [intelephense](https://marketplace.visualstudio.com/items?itemName=bmewburn.vscode-intelephense-client) (`bmewburn.vscode-intelephense-client`)
- PHP 8.x with the `php` binary available (or configured via `bladeParser.phpCommand`)

> [!Note]
> if you are going to use docker make sure to include `-i` in your command,
> ex.`docker exec -i <app-image-name> php`

### Intelephense Configuration

The extension automatically configures Intelephense to work optimally with Blade files:

| Setting                                   | Value                     | Purpose                                                                       |
| ----------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `intelephense.codeLens.references.enable` | `false`                   | Disables duplicate code lens (extension shows references in both PHP & Blade) |
| `intelephense.references.exclude`         | `**/ctf0.blade-parser/**` | Excludes compiled Blade files from reference results                          |
| `intelephense.rename.exclude`             | `**/ctf0.blade-parser/**` | Excludes compiled Blade files from rename operations                          |

## Features

All standard VS Code language features enabled for Blade files

- **Go to Definition** -- jump to class/method/function definitions from Blade.
- **Find References** -- locate all references to a symbol across the project (php & blade).
- **Hover** -- type signatures and docblocks on hover.
- **Document Symbols** -- outline and breadcrumb navigation for PHP symbols (html,php,blade).
- **Reference CodeLens** -- see reference counts above (classes, methods, props/vars, etc...).
- **Reference Rename** -- update reference on rename.
- **Diagnostics** -- PHP errors/warnings.

### Variables Type Hinting :

> 1 : use @var comment

```blade
@foreach ($users as $user)
    {{-- @var \App\Models\User $user --}}
    @if ($user->isActive)
        // ..
    @endif
@endforeach
```

> 2 : use assertion

- add global function

    ```php
    use Webmozart\Assert\Assert;

    if (! \function_exists('_is')) {
        /**
         * @template T of object
         *
         * @param  class-string<T>  $type
         *
         * @return T
         */
        function _is(object $obj, string $type): object
        {
            return Assert::isInstanceOf($obj, $type);
        }
    }
    ```

- now use it like so

    ```blade
    @foreach ($users as $user)
        @if (_is($user, \App\Models\User::class)->isActive)
            // ..
        @endif
    @endforeach
    ```

> why u might use both ?

so you dont have to rewrite

```blade
@php
    // example
    $serverErrors = collect($errors->getBags())
        ->flatMap(fn($bag) => $bag->messages())
        ->toArray();

    // instead of
    $serverErrors = collect($errors->getBags())
        ->flatMap(function($bag) {
            /** @var \Illuminate\Support\MessageBag $bag */
            return $bag->messages();
        })
        ->toArray();

    // use
    $serverErrors = collect($errors->getBags())
        ->flatMap(fn($bag) => _is($bag, \Illuminate\Support\MessageBag::class)->messages())
        ->toArray();
@endphp
```

> [!Tip]
> we also have support for `@see`

```blade
{{-- @see \App\Models\User::isVerified() --}}
// ..
{{-- @see \App\View\Composers\UserComposer::compose() --}}
```

### View::share/composer :

- we support showing `type & value` on hover.
- we support `go to reference` through [Laravel Goto View](https://marketplace.visualstudio.com/items?itemName=ctf0.laravel-goto-view).
- the support for `View::creator` & data passed from controller is not possible without making an actual request to the endpoint.

### Blade File rename/move :

- Update `component & view` calls on file rename/move in **php & blade**.

### Markdown :

- using the grammar from [vscode-laravel](https://marketplace.visualstudio.com/items?itemName=laravel.vscode-laravel), we now have better support for blade fenced blocks in markdown.
