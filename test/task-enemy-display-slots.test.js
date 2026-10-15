import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, refreshTaskProgress } from '../src/tasks.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('206001 credits the pet kill of the only displayed slot, including an existing blocked save', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    try {
        call('EnterGame', { open_id: 'chicken-display-slot' })
        store.transact(session.id, 0, (state) => {
            state.world.map_id = 100
            state.taskEpochs[206001] = 1
            const node = makeNode(new TaskGraphs(tables).get(206001), 4, state)
            node.client_before = true
            state.tasks = [
                { task_id: 206001, nodes: [node], finish_nodes: [1, 3], reward_nodes: [], client_trace: true },
            ]
            delete state.pendingTaskStorySync
        })
        const source = store.load(session.id).state.pets[0].guid
        const target = ((4n << 56n) | 206001003n).toString()
        call('BattleInfoReduce', {
            uint64_dic: [source, target],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -2147483647 } }],
        })
        const state = store.load(session.id).state
        assert.equal(state.combat.entities[target].hp, 0)
        assert.equal(state.combat.entities[target].final_blow_guid, source)
        assert.equal(state.tasks[0].nodes[0].node_values[0], 1)
        assert.equal(Object.values(state.combat.entities).filter((entity) => entity.object_id === 206001003).length, 1)
        // Re-evaluate an old blocked save with only the real slot-0 tombstone.
        const blocked = structuredClone(state)
        blocked.tasks[0].nodes[0].node_values = [0]
        blocked.taskEvents = {}
        assert.equal(refreshTaskProgress(tables, blocked).length, 1)
        assert.equal(blocked.tasks[0].nodes[0].node_values[0], 1)
        const alive = structuredClone(blocked)
        alive.taskEvents = {}
        alive.tasks[0].nodes[0].node_values = [0]
        alive.combat.entities[target].hp = 1
        refreshTaskProgress(tables, alive)
        assert.equal(alive.tasks[0].nodes[0].node_values[0], 0)
        call('TaskClientCondAfter', { task_id: 206001, node_id: 4, indexes: [0] })
        call('TaskClientAfter', { task_id: 206001, node_id: 4 })
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_id, 5)
    } finally {
        store.close()
    }
})

test('slot selection follows extracted assets, inline overrides and client missing-asset fallback', () => {
    const group = (override) => ({ __type_TaskEnemiesOverrideData: { enemiesGroupId: 425, ...override } })
    assert.deepEqual(taskEnemyPacks(tables, group({ posAssetId: 0 })), [10300071])
    assert.equal(taskEnemyPacks(tables, group({ posAssetId: 20600101 })).length, 3)
    assert.equal(
        taskEnemyPacks(tables, group({ posAssetId: 20600101, useInlineEnemySlots: 1, enemySlots: [{}, {}] })).length,
        2,
    )
    assert.equal(
        taskEnemyPacks(tables, group({ posAssetId: 20600101, useInlineEnemySlots: 1, enemySlots: [] })).length,
        3,
    )
    assert.equal(taskEnemyPacks(tables, group({ posAssetId: 987654321 })).length, 1)
})
