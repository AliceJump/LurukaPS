import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import fs from 'node:fs'
import { npcDuelEntry } from '../src/npc-kibo-duel.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)

function fixture(duelId = 501) {
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
    call('EnterGame', { open_id: 'npc-buff-stage' })
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
            return call('EnterGame', { open_id: 'npc-buff-stage' })
        },
    }
}

function elements(packets, op = 10) {
    return packets
        .filter((packet) => packet.id === 10706)
        .flatMap((packet) =>
            packet.data.battle_info
                .filter((row) => row.element_info?.op === op)
                .map(({ element_info: raw }) => {
                    const lookup = (index) =>
                        index === undefined || String(index) === '0' ? '0' : packet.data.uint64_dic[Number(index) - 1]
                    return {
                        ...raw,
                        uniqueId: lookup(raw.uniqueId),
                        tar_id: lookup(raw.tar_id),
                        buff: {
                            ...raw.buff,
                            cfg_id: [1, 10].includes(op) ? Number(lookup(raw.buff.cfg_id)) : undefined,
                            attacker_id: lookup(raw.buff.attacker_id),
                            executor_id: lookup(raw.buff.executor_id),
                        },
                    }
                }),
        )
}

test('all mapped NPC stage roots retain actual native buff roots and their child property configurations', () => {
    const { elements: profiles } = JSON.parse(
        fs.readFileSync(new URL('../configs/npc-arena-stage-buffs.json', import.meta.url), 'utf8'),
    )
    let valid = 0
    for (const row of tables.get('kibo_duel').filter((row) => row.type === 1)) {
        try {
            npcDuelEntry(tables, row.id)
        } catch {
            continue
        }
        valid++
        for (const pair of row.buffTime.split('|')) {
            const [at, id] = pair.split('#').map(Number),
                profile = profiles[id]
            assert.ok(at > 0 && at < row.time)
            assert.equal(profile.time, -1)
            assert.equal(profile.combine_type, 5)
            assert.equal(profile.apply_to, 1)
            assert.deepEqual(
                profile.children.map((child) => child.attribute_id),
                [21, 123, 24],
            )
        }
    }
    assert.equal(valid, 217)
})

test('the first stage starts at table120 seconds, applies actual roots to both rosters and never to trainers', () => {
    const f = fixture()
    try {
        const start = f.run().regular_started_at
        f.set(start + 119.9)
        assert.equal(elements(f.tick()).length, 0)
        f.set(start + 120)
        const packets = f.tick(),
            rows = elements(packets),
            info = packets.find((packet) => packet.id === 11800 && packet.data.in_speed_stage)
        assert.ok(info, 'Fever event and actual effect delivery must both exist')
        assert.equal(info.data.status_elapsed_time, '120000')
        assert.equal(rows.length, 16)
        assert.deepEqual(new Set(rows.map((row) => row.tar_id)), new Set(Object.keys(f.run().actors)))
        assert.ok(
            rows.every(
                (row) =>
                    row.buff.cfg_id === 520201007 &&
                    row.buff.layer === 1 &&
                    row.tar_id === row.buff.attacker_id &&
                    row.tar_id === row.buff.executor_id,
            ),
        )
        assert.equal(new Set(rows.map((row) => row.uniqueId)).size, 16)
        assert.ok(rows.every((row) => BigInt(row.uniqueId) > 2n ** 53n && BigInt(row.uniqueId) < 2n ** 64n))
        assert.equal(Object.keys(f.run().in_fight).length, 2, 'do not deploy hands to apply the native field-only buff')
        f.set(start + 121)
        assert.equal(elements(f.tick()).length, 0)
    } finally {
        f.store.close()
    }
})

test('delayed ticks retain all crossed permanent roots, skip defeated actors and do not stack on later deployment', () => {
    const f = fixture()
    try {
        const dead = Object.values(f.run().actors).find((actor) => !f.run().in_fight[actor.uuid])
        f.store.transact(1, 0, (state) => {
            state.combat.entities[dead.uuid].hp = 0
        })
        f.set(f.run().regular_started_at + 241)
        const rows = elements(f.tick())
        assert.equal(rows.length, 45)
        assert.deepEqual(new Set(rows.map((row) => row.buff.cfg_id)), new Set([520201007, 520201015, 520201019]))
        assert.ok(rows.every((row) => row.tar_id !== dead.uuid))
        const hand = Object.values(f.run().actors).find(
            (actor) => actor.camp === 1 && !f.run().in_fight[actor.uuid] && actor.uuid !== dead.uuid,
        )
        assert.equal(
            rows.filter((row) => row.tar_id === hand.uuid).length,
            3,
            'native hand pause keeps stage roots for later entry',
        )
        const packets = f.call('KiboDuelArenaSummonReq', {
            pet_guid: hand.uuid,
            source_pet_guid: hand.source_guid,
            pos: f.run().positions.selfSummon.pos,
            angle: hand.angle,
        })
        assert.equal(elements(packets).length, 0)
        f.set(f.run().regular_started_at + 242)
        assert.equal(elements(f.tick()).length, 0)
    } finally {
        f.store.close()
    }
})

test('relogin restores every elapsed root once with stable IDs, and all regular snapshots retain Fever', () => {
    const f = fixture(1002)
    try {
        f.set(f.run().regular_started_at + 185)
        const rows = elements(f.tick())
        assert.equal(rows.length, 32)
        const login = f.relogin().filter((packet) => packet.id === 11800)
        assert.ok(login.length && login.every((packet) => packet.data.in_speed_stage))
        assert.equal(elements(f.call('StartDungeonClientOk')).length, 0)
        const ready = f.call('MultiCampaignPlayerLoadFinish')
        assert.deepEqual(new Set(elements(ready).map((row) => row.uniqueId)), new Set(rows.map((row) => row.uniqueId)))
        assert.ok(ready.filter((packet) => packet.id === 11800).every((packet) => packet.data.in_speed_stage))
        assert.equal(elements(f.call('MultiCampaignPlayerLoadFinish')).length, 0)
        f.set(f.run().regular_started_at + 186)
        assert.equal(elements(f.tick()).length, 0)
    } finally {
        f.store.close()
    }
})

test('pause excludes wall time from buff thresholds and restores Fever with active elapsed milliseconds', () => {
    const f = fixture()
    try {
        f.set(f.run().regular_started_at + 100)
        f.call('GamePause', { operate: true, game_time: '100000' })
        f.set(f.run().pause.server_at + 200)
        assert.equal(elements(f.tick()).length, 0)
        const resumed = f.call('GamePause', { operate: false, game_time: '300000' })
        assert.ok(resumed.filter((packet) => packet.id === 11800).every((packet) => !packet.data.in_speed_stage))
        f.set(f.run().regular_started_at + 120)
        assert.equal(elements(f.tick()).length, 16)
        f.call('GamePause', { operate: true, game_time: '320000' })
        f.set(f.run().pause.server_at + 200)
        const resumed2 = f.call('GamePause', { operate: false, game_time: '520000' })
        assert.equal(resumed2.find((packet) => packet.id === 11800).data.in_speed_stage, true)
        assert.equal(resumed2.find((packet) => packet.id === 11800).data.status_elapsed_time, '120000')
        assert.equal(elements(resumed2).length, 0)
    } finally {
        f.store.close()
    }
})

test('failed root serialization rolls back all stage markers; retry remains deduplicated without immediate SQLite writes', () => {
    const f = fixture()
    try {
        f.set(f.run().regular_started_at + 120)
        const before = structuredClone(f.state().combat),
            writes = f.store.db.prepare('SELECT total_changes() AS n').get().n,
            original = f.game.packet
        f.game.packet = function (name, data, ...rest) {
            if (name === 'SCProtoBattleInfoReduceNtf' && data.battle_info?.some((row) => row.element_info?.op === 10))
                throw Error('stage effect packet fault')
            return original.call(this, name, data, ...rest)
        }
        assert.throws(() => f.tick(), /stage effect packet fault/)
        f.game.packet = original
        assert.deepEqual(f.state().combat, before)
        assert.equal(elements(f.tick()).length, 16)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
    } finally {
        f.store.close()
    }
})

test('result and early quit remove roots; a new match cannot inherit the previous stage or IDs', () => {
    for (const end of ['KiboDuelSurrender', 'MultiCampaignQuit']) {
        const f = fixture(1002)
        try {
            f.set(f.run().regular_started_at + 120)
            const before = elements(f.tick())
            const ended = f.call(end)
            assert.deepEqual(
                new Set(elements(ended, 2).map((row) => row.uniqueId)),
                new Set(before.map((row) => row.uniqueId)),
            )
            if (end === 'MultiCampaignQuit') continue
            assert.ok(ended.filter((packet) => packet.id === 11800).every((packet) => !packet.data.in_speed_stage))
            f.set(f.run().exit_at)
            f.tick()
            f.call('MultiCampaignRestart')
            f.call('MultiCampaignPlayerLoadFinish')
            f.call('KiboDuelArenaFirstConfirmReq')
            f.set(f.run().intro_until)
            assert.equal(elements(f.tick()).length, 0)
            f.call('ControlMapAI', { control_type: 0, status: 1 })
            f.set(f.run().regular_started_at + 120)
            const after = elements(f.tick())
            assert.equal(after.length, 16)
            assert.ok(after.every((row) => !before.some((old) => old.uniqueId === row.uniqueId)))
        } finally {
            f.store.close()
        }
    }
})

test('client root echoes do not mint another buff, and settlement clears echoed descendants without touching unrelated effects', () => {
    const f = fixture()
    try {
        f.set(f.run().regular_started_at + 120)
        const packet = f
            .tick()
            .find((packet) => packet.id === 10706 && packet.data.battle_info.some((row) => row.element_info?.op === 10))
        const base = String((f.run().regular_started_at + 120) * 1000)
        const echo = structuredClone(packet.data)
        echo.base_time = base
        for (const { element_info: row } of echo.battle_info) {
            row.op = 1
            row.buff.begin_time = String(BigInt(base) - BigInt(row.buff.begin_time))
            row.verify_info.op_time = '0'
        }
        const roots = elements([packet])
        f.call('BattleInfoReduce', echo)
        assert.ok(roots.every((row) => f.state().combat.elements[row.uniqueId]))
        f.set(f.run().regular_started_at + 121)
        assert.equal(elements(f.tick()).length, 0)
        // Model already-reported descendants of one native injected root.
        f.store.transact(1, 0, (state) => {
            state.combat.elements['901'] = { uniqueId: '901', parentUniqueId: roots[0].uniqueId }
            state.combat.elements['902'] = { uniqueId: '902', parentUniqueId: '901' }
            state.combat.elements['903'] = { uniqueId: '903', buff: { cfg_id: 1 } }
        })
        const before = structuredClone(f.state().combat),
            original = f.game.packet
        f.game.packet = function (name, data, ...rest) {
            if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('settlement after-buff-cleanup fault')
            return original.call(this, name, data, ...rest)
        }
        assert.throws(() => f.call('KiboDuelSurrender'), /after-buff-cleanup fault/)
        f.game.packet = original
        assert.deepEqual(f.state().combat, before)
        assert.equal(elements(f.call('KiboDuelSurrender'), 2).length, 16)
        assert.ok(roots.every((row) => !f.state().combat.elements[row.uniqueId]))
        assert.equal(f.state().combat.elements['901'], undefined)
        assert.equal(f.state().combat.elements['902'], undefined)
        assert.ok(f.state().combat.elements['903'])
    } finally {
        f.store.close()
    }
})
