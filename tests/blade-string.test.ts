import {test} from 'node:test'
import assert from 'node:assert/strict'
import {matchingParen, getBladePropsExpressions, extractPropsFromExpression, findValueEnd} from '../src/libs/text/blade-string.ts'

test('matchingParen: nested parens and strings', () => {
    assert.equal(matchingParen('(a(b)c)', 0), 6)
    assert.equal(matchingParen('(\'(\')\')', 0), 4)
    assert.equal(matchingParen('(a', 0), undefined)
})
test('getBladePropsExpressions: finds @props arrays', () => {
    const source = '@props([\'title\' => \'x\', \'items\' => [1, 2]])'
    const expressions = getBladePropsExpressions(source)

    assert.equal(expressions.length, 1)
    assert.equal(source.slice(expressions[0].start, expressions[0].end), '[\'title\' => \'x\', \'items\' => [1, 2]]')
})

test('getBladePropsExpressions: skips @props without array', () => {
    assert.equal(getBladePropsExpressions('@props($foo)').length, 0)
})

test('findValueEnd: stops at top-level comma, not nested', () => {
    const source = '[\'items\' => [1, 2], \'x\' => \'y\']'
    const valueStart = source.indexOf('[1, 2]')
    const close = source.length - 1

    assert.equal(findValueEnd(source, valueStart, close), source.indexOf(']') + 1)
})

test('extractPropsFromExpression: nested array values', () => {
    const source = '@props([\'items\' => [1, 2], \'title\' => \'x\'])'
    const {start, end} = getBladePropsExpressions(source)[0]
    const props = extractPropsFromExpression(source, start, end)

    assert.equal(props.length, 2)
    assert.equal(props[0].name, 'items')
    assert.equal(props[0].valueExpression, '[1, 2]')
    assert.equal(props[1].name, 'title')
    assert.equal(props[1].valueExpression, '\'x\'')
})

test('extractPropsFromExpression: string values with commas', () => {
    const source = '@props([\'label\' => \'a, b\', \'count\' => 3])'
    const {start, end} = getBladePropsExpressions(source)[0]
    const props = extractPropsFromExpression(source, start, end)

    assert.equal(props.length, 2)
    assert.equal(props[0].valueExpression, '\'a, b\'')
    assert.equal(props[1].valueExpression, '3')
})

test('extractPropsFromExpression: bare keys without values', () => {
    const source = '@props([\'title\', \'count\' => 3])'
    const {start, end} = getBladePropsExpressions(source)[0]
    const props = extractPropsFromExpression(source, start, end)

    assert.equal(props.length, 2)
    assert.equal(props[0].valueExpression, '')
    assert.equal(props[1].valueExpression, '3')
})

test('extractPropsFromExpression: escaped quote in key', () => {
    const source = '@props([\'it\\\'s\' => 1, \'ok\' => 2])'
    const {start, end} = getBladePropsExpressions(source)[0]
    const props = extractPropsFromExpression(source, start, end)

    assert.equal(props.length, 2)
    assert.equal(props[0].name, 'it\\\'s')
    assert.equal(props[0].valueExpression, '1')
    assert.equal(props[1].name, 'ok')
})

test('extractPropsFromExpression: nested function calls', () => {
    const source = '@props([\'items\' => collect([1, 2])->all(), \'x\' => 1])'
    const {start, end} = getBladePropsExpressions(source)[0]
    const props = extractPropsFromExpression(source, start, end)

    assert.equal(props.length, 2)
    assert.equal(props[0].valueExpression, 'collect([1, 2])->all()')
})
