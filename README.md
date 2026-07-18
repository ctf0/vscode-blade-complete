# Blade Complete

VS Code extension that brings language intelligence to Laravel Blade templates (`.blade.php`).

## Requirements

- [intelephense](https://marketplace.visualstudio.com/items?itemName=bmewburn.vscode-intelephense-client) (`bmewburn.vscode-intelephense-client`)
- PHP 8.x with the `php` binary available (or configured via `bladeComplete.phpCommand`)

> [!Note]
> if you are going to use docker make sure to include `-i` in your command,
> ex.`docker exec -i <app-image-name> php`

### Recommended Intelephense Configuration

```json
"intelephense.codeLens.references.enable": false,
"intelephense.files.exclude": [
  "**/.*/**",
  "**/.*",
  "**/CVS/**",
  "**/storage/**",
  "**/node_modules/**",
  "**/var/**",
  "**/stubs/**"
],
"intelephense.references.exclude": [
    "**/ctf0.blade-complete/**"
],
"intelephense.rename.exclude": [
  "**/vendor/**",
  "**/ctf0.blade-complete/**"
]
```

## Features

<table align="center">
  <tr>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/autocomplete.png" width="300" alt="autocomplete"/></td>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/autosuggestion.png" width="300" alt="autosuggestion"/></td>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/components_support.png" width="300" alt="components_support"/></td>
  </tr>
  <tr>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/diag.png" width="300" alt="diag"/></td>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/methods.png" width="300" alt="methods"/></td>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/props.png" width="300" alt="props"/></td>
  </tr>
  <tr>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/ref.png" width="300" alt="ref"/></td>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/view_share.png" width="300" alt="view_share"/></td>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/symbols.png" width="300" alt="symbols"/></td>
  </tr>
  <tr>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/code-block.png" width="300" alt="code-block"/></td>
    <td align="center"><img src="https://github.com/ctf0/vscode-blade-complete/releases/download/init/preview.png" width="300" alt="preview"/></td>
  </tr>
</table>

All standard VS Code language features enabled for Blade files

- **Go to Definition** - jump to every supported php type "class/method/var/etc..." definitions from Blade.
- **Find References** - locate all references to a symbol across the project (php & blade).
- **Hover** - type signatures and docblocks on hover.
- **Document Symbols** - outline and breadcrumb navigation for symbols (html, php, blade).
- **Reference CodeLens** - see reference counts above (classes, methods, props/vars, etc...).
- **Reference Rename** - update reference on rename.
    - you can also install [PHP-Refactor](https://marketplace.visualstudio.com/items?itemName=ctf0.vscode-php-refactor) if you need php namespace reference update in both php & blade
- **Diagnostics** - PHP errors/warnings.

### Variables Type Hinting (use any/both) :

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
> you can also use `@see`

```blade
{{-- @see \App\Models\User::isVerified() --}}
// ..
{{-- @see \App\View\Composers\UserComposer::compose() --}}
```

<hr>

### View::share/composer :

> [!NOTE]
> "`View::creator` & data passed from controller" support is not possible without making an actual request to the endpoint.

- `go to reference` through [Laravel Goto View](https://marketplace.visualstudio.com/items?itemName=ctf0.laravel-goto-view).
- show`type & value` on hover.

<hr>

### Blade file rename/move :

- Update `component & view` calls on file rename/move in **php & blade**.

<hr>

### Markdown syntax highlight:

- using the grammar from [vscode-laravel](https://marketplace.visualstudio.com/items?itemName=laravel.vscode-laravel), we now have better support for blade fenced blocks in markdown.

<hr>

### Default types :

- you can use `bladeComplete.phpDocBlocks` & `bladeComplete.phpDefaultImports` to inject default type hints to be available across all blade files so you dont have to write them in each file.
    - make sure to reindex the project/workspace after any modification using `"Blade: Index Workspace"`

<hr>

### @props/@php declarations :

- `go to definition`
- show `type` on hover.
