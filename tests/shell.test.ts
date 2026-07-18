import {test} from 'node:test'
import assert from 'node:assert/strict'
import {splitCommand, phpString} from '../src/libs/text/shell.ts'

test('splitCommand: plain args', () => {
    assert.deepEqual(splitCommand('php -d memory_limit=1G'), ['php', '-d', 'memory_limit=1G'])
})

test('splitCommand: single-quoted arg', () => {
    assert.deepEqual(splitCommand('php \'a b\''), ['php', 'a b'])
})

test('splitCommand: double-quoted arg with escapes', () => {
    assert.deepEqual(splitCommand('php "a\\"b"'), ['php', 'a"b'])
    assert.deepEqual(splitCommand('php "a\\$b"'), ['php', 'a$b'])
})

test('splitCommand: empty quoted arg', () => {
    assert.deepEqual(splitCommand('php ""'), ['php', ''])
})

test('splitCommand: docker exec style', () => {
    assert.deepEqual(
        splitCommand('docker exec -i app php'),
        ['docker', 'exec', '-i', 'app', 'php'],
    )
})

test('phpString: escapes backslashes and quotes', () => {
    assert.equal(phpString('a\'b\\c'), '\'a\\\'b\\\\c\'')
})
