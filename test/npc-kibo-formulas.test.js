import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateArenaFormula as calculate } from '../src/npc-kibo-formulas.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'

const catalog = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-formulas.json', import.meta.url), 'utf8'))

test('compiled client formula IDs cover the actual table and preserve source bytecode errors', () => {
    const tables = new Tables(configuration().tables),
        rows = tables.get('element_formula')
    assert.equal(rows.length, 248)
    assert.deepEqual(
        Object.keys(catalog.formulas)
            .map(Number)
            .sort((a, b) => a - b),
        rows.map((r) => r.id).sort((a, b) => a - b),
    )
    for (const row of rows) assert.equal(catalog.formulas[row.id].display, row.functionOutput)
    // This asset differs from the display text: it leaves two stack values.
    // Keep it rejected rather than substituting a formula compiled from text.
    assert.equal(catalog.formulas[1005].stack_valid, false)
    assert.throws(() => calculate(1005), /invalid source stack/)
})

test('all 247 structurally valid formulas execute with explicit external inputs', () => {
    const context = {
        parameter: () => 100,
        entity: () => 1000,
        random: () => 37,
        worldLevel: () => 8,
        activityAttribute: () => 1200,
    }
    let count = 0
    for (const [id, formula] of Object.entries(catalog.formulas)) {
        if (!formula.stack_valid) continue
        assert.ok(Number.isFinite(calculate(id, context)), `formula ${id}`)
        count++
    }
    assert.equal(count, 247)
})

test('formula evaluation retains source/self/target roles and native property component selectors', () => {
    const calls = []
    const context = {
        parameter: (index) => (index === 0 ? 2500 : 0),
        entity: (item) => {
            calls.push(item)
            return item.target === 3 ? 120 : item.target === 2 ? 2000 : 80
        },
    }
    assert.equal(calculate(4, context), 30) // source.ATK*A/10000
    assert.equal(calculate(6, context), 20) // self.SPEED*A/10000
    assert.equal(calculate(108, context), 500) // target.MAXHP*A/10000
    assert.deepEqual(
        calls.map((item) => [item.target, item.operation, item.custom_int]),
        [
            [3, 1, 0],
            [1, 35, 0],
            [2, 5, 0],
        ],
    )
})

test('grade branches use eager native IF evaluation and exact parameter indexes', () => {
    const parameters = { 0: 10000, 16: 100, 17: 200, 18: 400, 20: 800 }
    let gradeReads = 0
    const context = {
        parameter: (index) => parameters[index] ?? 0,
        entity: (item) => {
            if (item.operation === -19) {
                gradeReads++
                return 4
            }
            assert.equal(item.target, 1)
            assert.equal(item.operation, 1)
            return 100
        },
    }
    assert.equal(calculate(2, context), 107)
    assert.equal(gradeReads, 4)
})

test('native rounding distinguishes CEILING odd/even ties from conventional ceiling', () => {
    const context = (value) => ({ entity: () => value, parameter: (index) => ([7, 8].includes(index) ? 1 : 0) })
    assert.equal(calculate(106000, context(1)), 2)
    assert.equal(calculate(106000, context(2)), 2)
    assert.equal(calculate(106000, context(0)), 0)
    assert.equal(calculate(105000, context(-1.5)), -2)
    assert.equal(calculate(107000, context(2.5)), 2)
    assert.equal(calculate(107000, context(3.5)), 4)
})

test('activity functions resolve their serialized ID, and division by zero is observable', () => {
    assert.equal(
        calculate(130001, {
            parameter: (index) => (index === 0 ? 10000 : 5),
            activityAttribute: (id) => {
                assert.equal(id, 101)
                return 1000
            },
        }),
        205,
    )
    const zeros = []
    assert.equal(calculate(106000, { entity: () => 10, parameter: () => 0, onZeroDivision: (id) => zeros.push(id) }), 0)
    assert.deepEqual(zeros, [106000])
})

test('unknown formulas and unavailable entity, parameter or random inputs never silently become zero', () => {
    assert.throws(() => calculate(0), /Unknown arena formula/)
    assert.throws(() => calculate(5), /missing or invalid parameter/)
    assert.throws(() => calculate(4, { parameter: () => 1 }), /missing or invalid entity/)
    assert.throws(() => calculate(5, { parameter: () => NaN }), /missing or invalid parameter/)
    const randomFormula = Object.entries(catalog.formulas).find(([, row]) =>
        row.items.some((item) => item.kind === 0 && item.operation === 5),
    )[0]
    assert.throws(() => calculate(randomFormula, { entity: () => 1, parameter: () => 1 }), /missing or invalid random/)
})
