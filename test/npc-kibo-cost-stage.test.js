import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)

function fixture(duelId = 1002) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, {
            clock: () => Math.floor(now),
            arenaClockMs: () => Math.round(now * 1000),
        }),
        state = () => store.load(session.id).state,
        decode = (packets) =>
            packets.map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            })),
        call = (name, request = {}) => {
            const e = protocol.byName.get('CSProto' + name)
            return decode(game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) }))
        }
    call('EnterGame', { open_id: 'npc-cost-stage' })
    call('KiboDuelGetGroup', { u32: duelId })
    const duel = tables.find('kibo_duel', duelId),
        group = structuredClone(state().kiboDuelGroups[0]),
        used = new Set(group.pet_guids.filter((pet) => !pet.is_trial).map((pet) => pet.id)),
        available = state().pets.filter((pet) => !used.has(pet.guid))
    for (let i = 0; i < group.pet_guids.length; i++)
        if (group.pet_guids[i].id === '0') group.pet_guids[i] = { id: available.shift().guid, is_trial: false }
    call('KiboDuelGroupChange', { type: 6, group })
    call('MultiCampaignCreate', { dungeon_id: duel.dungeonId })
    call('StartDungeonClientOk')
    call('MultiCampaignPlayerLoadFinish')
    call('KiboDuelArenaFirstConfirmReq')
    now = state().combat.npcDuel.intro_until
    game.tickArena(session.id, session)
    call('ControlMapAI', { control_type: 0, status: 1 })
    return {
        store,
        game,
        state,
        call,
        run: () => state().combat.npcDuel,
        set: (value) => {
            now = value
        },
        tick: () => decode(game.tickArena(session.id, session)),
        relogin: () => {
            session = {}
            return call('EnterGame', { open_id: 'npc-cost-stage' })
        },
    }
}

const changes = (packets) => packets.filter((packet) => packet.id === 11800 && packet.data.cost_change)

test('configured cost threshold sends one native cost event, separately from the fever event and before energy sync', () => {
    const f = fixture()
    try {
        const start = f.run().regular_started_at
        for (const seconds of [17, 18]) {
            f.set(start + seconds)
            assert.equal(changes(f.tick()).length, 0)
        }
        f.set(start + 18.1)
        const packets = f.tick(),
            speed = changes(packets)
        assert.equal(speed.length, 1, 'native event7 must switch ModuleDuelEnergy.isSpeed')
        assert.equal(speed[0].data.status, 4)
        assert.equal(speed[0].data.status_endtime, String(f.run().end_at))
        assert.ok(!speed[0].data.in_speed_stage, 'event6/Fever is a different feature')
        assert.ok(packets.indexOf(speed[0]) < packets.findIndex((packet) => packet.id === 11814))
        assert.ok(Math.abs(f.run().energy[1].points - 202) < 1e-5)
        for (const seconds of [19, 20, 21, 24]) {
            f.set(start + seconds)
            assert.equal(changes(f.tick()).length, 0, 'repeated true events restart the native recovery animation')
        }
    } finally {
        f.store.close()
    }
})

test('cost stage restores after entity readiness on relogin, without repeating on duplicate readiness', () => {
    const f = fixture()
    try {
        f.set(f.run().regular_started_at + 19)
        f.tick()
        assert.equal(changes(f.relogin()).length, 0, 'do not consume the event before the new UI is ready')
        assert.equal(changes(f.call('StartDungeonClientOk')).length, 0)
        assert.equal(changes(f.call('MultiCampaignPlayerLoadFinish')).length, 1)
        assert.equal(changes(f.call('MultiCampaignPlayerLoadFinish')).length, 0)
        f.set(f.run().regular_started_at + 20)
        assert.equal(changes(f.tick()).length, 0)
    } finally {
        f.store.close()
    }
})

test('pause freezes the cost threshold; a fast-stage resume explicitly restores the native interval', () => {
    const f = fixture()
    try {
        const start = f.run().regular_started_at
        f.set(start + 10)
        f.call('GamePause', { operate: true, game_time: '10000' })
        f.set(start + 110)
        f.relogin()
        f.call('StartDungeonClientOk')
        assert.equal(changes(f.call('MultiCampaignPlayerLoadFinish')).length, 0, 'paused wall time is not battle time')
        assert.equal(changes(f.call('GamePause', { operate: false, game_time: '110000' })).length, 0)
        f.set(f.run().regular_started_at + 18.1)
        assert.equal(changes(f.tick()).length, 1)
        f.call('GamePause', { operate: true, game_time: '118100' })
        f.set(f.run().pause.server_at + 100)
        f.relogin()
        f.call('StartDungeonClientOk')
        assert.equal(
            changes(f.call('MultiCampaignPlayerLoadFinish')).length,
            1,
            'fast-stage paused rebuild retains the stage',
        )
        const resumed = f.call('GamePause', { operate: false, game_time: '218100' })
        assert.equal(changes(resumed).length, 1)
        f.set(f.run().regular_started_at + 19)
        assert.equal(changes(f.tick()).length, 0)
    } finally {
        f.store.close()
    }
})

test('failed stage encoding rolls back the memory transaction and retries without immediate SQLite writes', () => {
    const f = fixture()
    try {
        f.set(f.run().regular_started_at + 19)
        const before = structuredClone(f.state().combat),
            writes = f.store.db.prepare('SELECT total_changes() AS n').get().n,
            original = f.game.packet
        let stageEncoded = false
        f.game.packet = function (name, data, ...rest) {
            if (name === 'SCProtoKiboDuelArenaInfoSync' && data.cost_change) stageEncoded = true
            if (stageEncoded && name === 'SCProtoKiboDuelArenaActionPointSync')
                throw new Error('cost-stage encode fault')
            return original.call(this, name, data, ...rest)
        }
        assert.throws(() => f.tick(), /cost-stage encode fault/)
        f.game.packet = original
        assert.ok(stageEncoded, 'fail after the new stage marker has been written in the draft')
        assert.deepEqual(f.state().combat, before)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        assert.equal(changes(f.tick()).length, 1)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
    } finally {
        f.store.close()
    }
})

test('a restarted arena begins with the configured normal interval and publishes its own later transition', () => {
    const f = fixture()
    try {
        f.set(f.run().regular_started_at + 19)
        assert.equal(changes(f.tick()).length, 1)
        f.call('KiboDuelSurrender')
        assert.equal(changes(f.call('MultiCampaignPlayerLoadFinish')).length, 0)
        f.set(f.run().exit_at)
        f.tick()
        f.call('MultiCampaignRestart')
        f.call('MultiCampaignPlayerLoadFinish')
        f.call('KiboDuelArenaFirstConfirmReq')
        f.set(f.run().intro_until)
        assert.equal(changes(f.tick()).length, 0)
        assert.equal(f.run().cost_stage_sent, undefined)
        assert.equal(f.run().energy[1].points, 100)
        f.set(f.run().regular_started_at + 19)
        assert.equal(changes(f.tick()).length, 1)
    } finally {
        f.store.close()
    }
})

test('empty costTime never emits a cost-speed notification', () => {
    const f = fixture(501)
    try {
        f.set(f.run().regular_started_at + 20)
        assert.equal(changes(f.tick()).length, 0)
        f.call('KiboDuelSurrender')
        assert.equal(changes(f.call('MultiCampaignPlayerLoadFinish')).length, 0)
    } finally {
        f.store.close()
    }
})
