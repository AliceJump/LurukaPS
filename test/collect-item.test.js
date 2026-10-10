import { recordResourceAcquisition } from '../src/item-acquisition.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { guidedCollectRule, guidedConditionValue } from '../src/guided-conditions.js'
import { grantRewards } from '../src/rewards.js'
import { spend } from '../src/inventory.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('all 35 current CollectItem definitions use typed table parameters; legacy stock and future acquisition are counted', () => {
    const rows = tables.get('task_condition').filter((r) => String(r.condition).startsWith('12029|'))
    assert.equal(rows.length, 35)
    for (const row of rows) assert.ok(guidedCollectRule(row.id))
    const state = {
        player: {
            sbag_infos: { items: [{ itemid: 306000, itemnum: 2, itemtype: 3, guid: '1' }] },
            basic_info: { gold: 0 },
        },
        inventoryVersion: 1,
        nextItemGuid: '2',
    }
    assert.equal(guidedConditionValue(10001, state), 2)
    grantRewards(tables, state, [{ itemtype: 3, itemid: 306001, itemnum: 99 }])
    assert.equal(guidedConditionValue(10001, state), 2)
    grantRewards(tables, state, [{ itemtype: 3, itemid: 306000, itemnum: 1 }])
    assert.equal(guidedConditionValue(10001, state), 3)
    spend(state, new Map([[306000, 3]]))
    assert.equal(guidedConditionValue(10001, state), 3, 'using collected fruit must not erase acquisition history')
})
test('real red-fruit tree advances side task216008/13 through ordinary collection and does not count repeated claims', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { rng: () => 0 }),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call('EnterGame', { open_id: 'red-fruit' })
        const tree = new WorldObjectCatalog(tables).object(101, 500182)
        store.transact(session.id, 0, (s) => {
            Object.assign(s.world, tables.position(tables.get('world_borthpos').find((p) => p.cityId === 101)), {
                pos: tree.pos,
            })
            s.tasks = [
                {
                    task_id: 216008,
                    nodes: [{ ...makeNode(new TaskGraphs(tables).get(216008), 13, s), client_before: true }],
                    finish_nodes: [1, 3, 4, 7, 8, 9, 10, 11, 12],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
            s.taskRecords = tables
                .get('task')
                .filter((r) => r.type === 1)
                .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        })
        for (const [step, complete] of [
            [1, false],
            [2, false],
            [2, true],
        ])
            call('WorldObjInteract', {
                objs: [{ obj: { obj_id: 500182, complete, state_data: { step } }, interact_type: 0 }],
            })
        assert.equal(store.load(session.id).state.tasks.find((t) => t.task_id === 216008).nodes[0].node_values[0], 3)
        const collected = store.load(session.id).state.itemAcquisitionCounts['3:306000']
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: 500182, complete: true, state_data: { step: 2 } }, interact_type: 0 }],
        })
        assert.equal(store.load(session.id).state.itemAcquisitionCounts['3:306000'], collected)
        call('TaskClientCondAfter', { task_id: 216008, node_id: 13, indexes: [0] })
        call('TaskClientAfter', { task_id: 216008, node_id: 13 })
        assert.equal(store.load(session.id).state.tasks.find((t) => t.task_id === 216008).nodes[0].node_id, 32)
    } finally {
        store.close()
    }
})

test('building resource and acquisition ledger respect table types and shallow-draft rollback isolation', () => {
    const state = { home: { inventory: [{ build_id: 10000, total_num: 1, used_num: 1 }] } }
    assert.equal(guidedConditionValue(92004, state), 1)
    const base = { player: { sbag_infos: { items: [] } }, itemAcquisitionCounts: { '3:306000': 3 } }
    const draft = { ...base }
    recordResourceAcquisition(draft, 3, 306000, 1)
    recordResourceAcquisition(draft, 3, 306000, 1)
    assert.equal(draft.itemAcquisitionCounts['3:306000'], 5)
    assert.equal(base.itemAcquisitionCounts['3:306000'], 3)
})
