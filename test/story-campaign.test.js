import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { storyCampaignConfig, storyCampaignSnapshot } from '../src/story-campaign.js'

const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)

test('chapter 106014 opens its table-matched dungeon and only credits a defeated scene', () => {
    const store = new Store(':memory:')
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    const session = {}
    let seq = 1
    const call = (name, value = {}) => {
        const entry = protocol.byName.get(`CSProto${name}`)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(session.id).state
    const defeatScene = (objectId) => {
        const snapshot = state(),
            source = snapshot.player.heros_info.heros[0].guid
        const enemies = Object.values(snapshot.combat.entities).filter(
            (enemy) => enemy.hp > 0 && (!objectId || enemy.object_id === objectId),
        )
        return call('BattleInfoReduce', {
            uint64_dic: [source, ...enemies.map((enemy) => enemy.uuid)],
            battle_info: enemies.map((enemy, index) => ({
                hurt_info: {
                    from_id: '1',
                    tar_id: String(index + 2),
                    hp_change: -enemy.hp,
                },
            })),
        })
    }
    try {
        call('EnterGame', { open_id: 'chapter-story-dungeon' })
        store.transact(session.id, 0, (snapshot) => {
            snapshot.player.basic_info.lv = 16
            snapshot.world.map_id = 100
            snapshot.tasks = [
                {
                    task_id: 106014,
                    nodes: [{ node_id: 11, node_values: [0], client_before: true }],
                    finish_nodes: [1, 3, 4, 21, 5, 8, 10, 12],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
            snapshot.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013, 996001].map((task_id) => ({
                task_id,
                count: 1,
                time: 1,
            }))
        })
        assert.equal(storyCampaignConfig(tables, 200, 1).scenes[0].scene.id, 6200)
        const packets = call('CampaignCreate', { group_id: 200, difficulty: 1 })
        assert.equal(state().world.map_id, 6200)
        assert.equal(state().storyCampaign.dungeon_id, 10010)
        assert.equal(Object.keys(state().combat.entities).length, 14)
        assert.ok(Object.values(state().combat.entities).every((enemy) => enemy.level === 20))
        const map = packets.find((packet) => packet.id === 9103)
        const notice = protocol.decode('WorldMapNotify', map.payload)
        assert.equal(notice.map_info.campaign_start.group_id, 200)
        assert.equal(notice.map_info.objs.length, 3)
        const campaign = protocol.decode('CampaignInfo', packets.find((packet) => packet.id === 9505).payload)
        assert.equal(campaign.cur_scene_id, 6200)
        assert.equal(campaign.dungeon_instance_id, 10010)
        assert.throws(() => call('EndDungeonScene', { result: 3 }), /not defeated/)
        call('StartDungeonClientOk')
        call('TrialGroupChange', {
            open: true,
            force: false,
            trial_heros: [{ pos: 3, id: 2108003 }],
            trial_pets: [{ pos: 3, id: 0 }],
        })
        assert.equal(state().trialGroup.heroes[0].conf_id, 108003)
        assert.equal(
            state()
                .player.group_mgrs.find((manager) => manager.type === 1)
                .groups.find((group) => group.id === 0).heros.length,
            4,
        )
        const clearedWave = defeatScene(1500002)
        const refreshed = clearedWave
            .filter((packet) => packet.id === 9103)
            .flatMap((packet) => protocol.decode('WorldMapNotify', packet.payload).map_info?.objs ?? [])
        const deadGroup = refreshed.find((row) => row.obj_id === 1500002)
        assert.ok(deadGroup, 'legacy2500 emits the cleared group snapshot')
        assert.deepEqual(deadGroup.expand_data.battle_group.world_indexes, [])
        assert.ok(deadGroup.expand_data.battle_group.monsters.every((monster) => monster.hp === 0))
        assert.equal(deadGroup.time, state().storyCampaign.start_time)
        assert.equal(deadGroup.next_time, 0)
        assert.equal(deadGroup.next_time + 10 > deadGroup.time, false)
        const nextGroup = refreshed.find((row) => row.obj_id === 1500004)
        assert.deepEqual(
            nextGroup.expand_data.battle_group.world_indexes,
            nextGroup.expand_data.battle_group.monsters.map((_, index) => index),
        )
        assert.equal(state().storyCampaign.stage_index, 1)
        assert.equal(state().worldObjects['6200:1500002'].active, false)
        assert.equal(state().worldObjects['6200:1500004'].active, true)
        assert.deepEqual(state().storyCampaign.completed_scenes, [])
        store.transact(session.id, 0, (snapshot) => {
            delete snapshot.storyCampaign.stage_index
        })
        const login = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(
            {},
            {
                id: login.id,
                seq: 1,
                payload: protocol.encode(login.req, { open_id: 'chapter-story-dungeon', reconnect: true }),
            },
        )
        assert.equal(state().storyCampaign.stage_index, 1)
        assert.equal(state().worldObjects['6200:1500004'].active, true)
        defeatScene(1500004)
        assert.deepEqual(state().storyCampaign.completed_scenes, [6200])
        assert.equal(state().storyCampaignClears?.[10010], undefined)
        const beforeExp = state().player.basic_info.exp
        call('CampaignQuit')
        assert.equal(state().storyCampaignClears[10010].count, 1)
        assert.equal(state().tasks[0].nodes[0].node_values[0], 1)
        assert.equal(state().world.map_id, 100)
        assert.equal(state().storyCampaign, undefined)
        assert.equal(state().player.basic_info.exp, beforeExp + 50)
        // Migrate the save produced by the old 9507-only handler: it left the
        // dungeon after both configured groups died without a clear receipt.
        store.transact(session.id, 0, (snapshot) => {
            delete snapshot.storyCampaignClears
            snapshot.player.basic_info.exp = beforeExp
            snapshot.tasks[0].nodes[0].node_values[0] = 0
        })
        game.dispatch(
            {},
            {
                id: login.id,
                seq: 1,
                payload: protocol.encode(login.req, { open_id: 'chapter-story-dungeon', reconnect: true }),
            },
        )
        assert.equal(state().storyCampaignClears[10010].count, 1)
        assert.equal(state().tasks[0].nodes[0].node_values[0], 1)
        assert.equal(state().player.basic_info.exp, beforeExp + 50)
    } finally {
        store.close()
    }
})

test('campaign object snapshots omit internal claims while retaining server reward receipts', () => {
    const object = {
        obj_id: 1300001,
        active: true,
        complete: false,
        state_data: { step: 1 },
        claims: { complete: true },
    }
    const state = {
        storyCampaign: {
            dungeon_id: 10071,
            map_id: 6224,
            status: 2,
            start_time: 1800000000,
            completed_scenes: [],
            scene_objects: [object],
        },
    }
    const snapshot = storyCampaignSnapshot(state)
    assert.equal('claims' in snapshot.scene_datas[0].objs[0], false)
    assert.deepEqual(object.claims, { complete: true })
    assert.deepEqual(snapshot.scene_datas[0].objs[0].state_data, { step: 1 })
    assert.doesNotThrow(() => protocol.encode(protocol.byName.get('CSProtoCampaignInfoSync').rsp, snapshot))
})
