import {test} from 'node:test'
import assert from 'node:assert/strict'
import {isGeneratedCompletionNoise} from '../src/libs/compiler/generated-noise.ts'

test('isGeneratedCompletionNoise: filters compiler internals', () => {
    assert.equal(isGeneratedCompletionNoise('$__env'), true)
    assert.equal(isGeneratedCompletionNoise('$__newAttributes'), true)
    assert.equal(isGeneratedCompletionNoise('$__propNames'), true)
    assert.equal(isGeneratedCompletionNoise('$__defined_vars'), true)
    assert.equal(isGeneratedCompletionNoise('$__key'), true)
    assert.equal(isGeneratedCompletionNoise('$__value'), true)
    assert.equal(isGeneratedCompletionNoise('$__php_anything'), true)
})

test('isGeneratedCompletionNoise: filters generated names', () => {
    assert.equal(isGeneratedCompletionNoise('$__newAttributes'), true)
    assert.equal(isGeneratedCompletionNoise('$__propNames'), true)
    assert.equal(isGeneratedCompletionNoise('$__defined_vars'), true)
    assert.equal(isGeneratedCompletionNoise('$__key'), true)
    assert.equal(isGeneratedCompletionNoise('$__value'), true)
    assert.equal(isGeneratedCompletionNoise('$attributes'), true)
    assert.equal(isGeneratedCompletionNoise('$slot'), true)
    assert.equal(isGeneratedCompletionNoise('$component'), true)
})

test('isGeneratedCompletionNoise: keeps author-facing variables', () => {
    assert.equal(isGeneratedCompletionNoise('$errors'), false)
    assert.equal(isGeneratedCompletionNoise('$media'), false)
    assert.equal(isGeneratedCompletionNoise('$vs_auth_route'), false)
    assert.equal(isGeneratedCompletionNoise('$user'), false)
})

test('isGeneratedCompletionNoise: reserved vars kept only when source uses them', () => {
    assert.equal(isGeneratedCompletionNoise('$loop', '{{ $loop->index }}'), false)
    assert.equal(isGeneratedCompletionNoise('$attributes', '{{ $attributes->merge([]) }}'), false)
    assert.equal(isGeneratedCompletionNoise('$slot', '{{ $slot }}'), false)
    assert.equal(isGeneratedCompletionNoise('$component', '{{ $component }}'), false)
    assert.equal(isGeneratedCompletionNoise('$loop', '{{ $first }}'), true)
    assert.equal(isGeneratedCompletionNoise('$attributes', '{{ $media }}'), true)
})
