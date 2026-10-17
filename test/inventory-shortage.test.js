import { ErrorCode } from '../src/error-codes.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spendCurrency, spend } from '../src/inventory.js'

function wallet() {
    return {
        player: {
            basic_info: { diamond: 2, gold: 2 },
            attr_infos: { attrs: [{ attr_id: 103, attr_val: '2' }] },
            sbag_infos: { items: [] },
        },
    }
}
for (const id of [1, 2, 103, 902]) {
    test(`currency ${id} shortage returns CBT3 resource error without mutation`, () => {
        const state = wallet(),
            before = structuredClone(state)
        assert.throws(
            () => spendCurrency(state, id, 3),
            (error) => error.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(state, before)
        assert.throws(
            () => spendCurrency(state, id, -1),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
    })
}
test('shared item/gold spend uses the same resource shortage code', () => {
    const state = wallet(),
        before = structuredClone(state)
    assert.throws(
        () => spend(state, new Map(), 3),
        (error) => error.code === ErrorCode.ItemNotEnough,
    )
    assert.throws(
        () => spend(state, new Map([[300000, 1]])),
        (error) => error.code === ErrorCode.ItemNotEnough,
    )
    assert.deepEqual(state, before)
})
