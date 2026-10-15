import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { gridAnchor } from '../src/home-grid.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
for (const placementProtocol of ['BuildLocate', 'BuildCreate'])
    test(`task106010 cooking pot recipe/claim/${placementProtocol} advances its configured goal`, () => {
        const store = new Store(':memory:')
        let now = 1800000000,
            seq = 1
        const game = new Game(protocol, store, tables, { clock: () => now }),
            session = {}
        const call = (name, request = {}) => {
            const entry = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
        }
        try {
            call('EnterGame', { open_id: 'cooking-pot-main-task' })
            store.transact(session.id, 0, (state) => {
                state.world.map_id = Number(tables.get('game').find((x) => x.title === 'HOME_ID').value)
                const graph = new TaskGraphs(tables).get(106010)
                state.tasks = [
                    {
                        task_id: 106010,
                        nodes: [{ ...makeNode(graph, 192, state), client_before: true }],
                        finish_nodes: [191],
                        reward_nodes: [],
                        client_trace: true,
                    },
                ]
                state.taskEpochs[106010] = 1
                state.taskRecords = tables
                    .get('task')
                    .filter((row) => row.type === 1 && row.id !== 106010)
                    .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
                grantRewards(tables, state, [
                    { itemtype: 3, itemid: 300000, itemnum: 15 },
                    { itemtype: 3, itemid: 303000, itemnum: 5 },
                    { itemtype: 10, itemid: 103, itemnum: 300 },
                ])
            })
            assert.equal(store.load(session.id).state.home.builds[0].build_id, 10000)
            call('ProductStart', { build_guid: 1, product_id: 710018, count: 1 })
            now += 5
            call('ProductFinish', { guid: 1, is_all: true })
            let state = store.load(session.id).state
            const bag = state.home.inventory.find((x) => x.build_id === 100011)
            assert.equal(bag.total_num, 1)
            assert.equal(bag.used_num, 0)
            assert.equal(state.tasks.find((x) => x.task_id === 106010).nodes[0].node_values[0], 0)
            const packets = call(placementProtocol, {
                build_id: 100011,
                locate: { block_id: 101, anchor: gridAnchor(-50, -20), direction: 0 },
            })
            const placed = protocol.decode(
                'WorldMapHomeBuild',
                packets.find((x) => x.id === protocol.byName.get('CSProto' + placementProtocol).id).payload,
            )
            assert.equal(placed.build_id, 100011)
            state = store.load(session.id).state
            assert.equal(state.home.inventory.find((x) => x.build_id === 100011).used_num, 1)
            assert.equal(state.tasks.find((x) => x.task_id === 106010).nodes[0].node_values[0], 1)
            call('TaskClientCondAfter', { task_id: 106010, node_id: 192, indexes: [0] })
            call('TaskClientAfter', { task_id: 106010, node_id: 192 })
            assert.equal(store.load(session.id).state.tasks.find((x) => x.task_id === 106010).nodes[0].node_id, 193)
        } finally {
            store.close()
        }
    })
