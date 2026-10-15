import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPetAttributes } from '../src/kibo-arena-attributes.js'
import { initializeNpcDuelBattle } from '../src/npc-kibo-battle.js'
import { advanceArenaPetAI } from '../src/npc-kibo-pet-ai.js'
import { updateNpcArenaPause } from '../src/npc-kibo-pause.js'
import {
    recordArenaControlEvent,
    arenaControlState,
    advanceArenaControls,
    arenaPriorityTarget,
    clearArenaCardControls,
    arenaLockSelector,
    publishArenaControls,
    arenaTauntTarget,
} from '../src/npc-kibo-controls.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
const catalog = JSON.parse(
    fs.readFileSync(new URL('../configs/npc-arena-controls.json', import.meta.url), 'utf8'),
).elements
const byFlags = (flags) => Number(Object.entries(catalog).find(([, spec]) => spec.flags === flags)[0])

// Independent reconstruction of the receive-side fields read by0600066c.
// The report expander is deliberately not used: its timestamp rules differ.
function receivedElements(packet) {
    const guid = (index) => (String(index ?? '0') === '0' ? '0' : packet.uint64_dic[Number(index) - 1])
    return packet.battle_info.map(({ element_info: raw }) => {
        const e = structuredClone(raw),
            b = e.buff
        if (e.op === 10) e.tar_id = guid(e.tar_id)
        e.uniqueId = guid(e.uniqueId)
        if (e.parentUniqueId !== undefined) e.parentUniqueId = guid(e.parentUniqueId)
        for (const key of ['attacker_id', 'executor_id', 'source_id', 'creator_id'])
            if (b[key] !== undefined) b[key] = guid(b[key])
        if ([1, 10].includes(e.op)) b.cfg_id = Number(guid(b.cfg_id))
        if ([1, 7].includes(e.op)) b.begin_time = (BigInt(packet.base_time) + BigInt(b.begin_time ?? 0)).toString()
        for (const entry of b.entrys ?? [])
            if ([3, 4].includes(entry.key)) entry.ui64_dic_values = entry.ui64_dic_values.map(guid)
        return e
    })
}

function context() {
    const state = {
        player: { basic_info: { id: 1 } },
        world: { map_id: 1052 },
        multiCampaign: { duel_id: 501, map_id: 1052, start_time: 100, arena_status: 4 },
    }
    const attr = arenaPetAttributes(tables, 500097, 1)
    const run = initializeNpcDuelBattle(
        tables,
        state,
        {
            hero_info: { hero_guid: '123' },
            infos: [{ pet_guid: { guid: '456' }, pet_conf_id: 500097, pet_lv: 1, ...attr }],
        },
        100,
    )
    run.regular_started_at = 100
    run.end_at = 1000
    const self = Object.values(run.actors).find((actor) => actor.camp === 1),
        enemies = Object.values(run.actors).filter((actor) => actor.camp === 2)
    run.in_fight = Object.fromEntries(
        [self, ...enemies.slice(0, 3)].map((actor, i) => [
            actor.uuid,
            { entered_at: 100, move: { pos: { x: 10000, y: 10000, z: 10000 + i * 100 }, angle: 0 } },
        ]),
    )
    const packets = [],
        c = {
            state,
            tables,
            now: 100,
            randomInt: (low) => low,
            pushBefore: (name, data) => packets.push({ name, data }),
        }
    const add = (id, config, target = self.uuid, duration = '5000', begin = '100000', attacker = '0') => {
        const event = {
            op: 1,
            uniqueId: id,
            tar_id: target,
            buff: { cfg_id: config, layer: 1, begin_time: begin, total_time: duration, attacker_id: attacker },
        }
        state.combat.elements[id] = event
        recordArenaControlEvent(c, event)
    }
    const del = (id) => {
        delete state.combat.elements[id]
        recordArenaControlEvent(c, { op: 2, uniqueId: id })
    }
    return { c, self, enemies, packets, add, del, run: () => state.combat.npcDuel }
}

test('compiled control and target selectors cover the actual MMap classes and preserve native slot mapping', () => {
    assert.equal(Object.values(catalog).filter((spec) => spec.kind === 'control').length, 103)
    assert.equal(Object.values(catalog).filter((spec) => spec.kind === 'lock').length, 9)
    assert.deepEqual(catalog[50300011].blocked_slots, [1, 2, 3, 4])
    assert.equal(catalog[50300011].block_skill, true)
    const basic = catalog[byFlags(7)]
    assert.deepEqual(basic.blocked_slots, [1])
    assert.equal(basic.block_move, true)
    assert.equal(basic.block_skill, false)
})

test('independent control instances are reference counted, retries keep expiry, and expiration restores only the removed constraints', () => {
    const f = context(),
        id = f.self.uuid
    f.run().pet_ai = { [id]: { moving: true } }
    f.add('901', 50300011)
    assert.ok(f.packets.some((packet) => packet.name === 'SCProtoKiboStopMove'))
    assert.equal(arenaControlState(f.c, id).can_skill, false)
    f.add('902', byFlags(2818), id, '10000')
    f.del('901')
    assert.equal(arenaControlState(f.c, id).can_skill, true)
    assert.equal(arenaControlState(f.c, id).can_move, false)
    f.c.now = 105
    f.add('902', byFlags(2818), id, '10000')
    assert.equal(f.run().controls['902'].expires_ms, '110000')
    f.c.now = 110
    advanceArenaControls(f.c)
    assert.equal(arenaControlState(f.c, id).can_move, true)
    assert.equal(f.run().controls['902'], undefined)
    assert.equal(f.c.state.combat.elements['902'], undefined)
    f.add('903', 50300011, id, '5000', '110000')
    const replacement = { op: 1, uniqueId: '903', tar_id: id, buff: { cfg_id: 999999, layer: 1 } }
    f.c.state.combat.elements['903'] = replacement
    recordArenaControlEvent(f.c, replacement)
    assert.equal(
        arenaControlState(f.c, id).can_move,
        true,
        'a UID reused by a different element cannot retain old control flags',
    )
    assert.equal(f.c.state.combat.elements['903'].buff.cfg_id, 999999)
})

test('silence prevents skill commands without HP/SP simulation; roots allow in-range skills and freeze the correct attack slot', () => {
    const f = context(),
        id = f.self.uuid,
        hp = f.c.state.combat.entities[id].hp
    f.c.now = 200
    f.add('910', 50300011, id, '5000', '200000')
    advanceArenaPetAI(f.c)
    assert.ok(!f.packets.some((packet) => packet.name === 'SCProtoSkillStartSync' && packet.data.unit_id === id))
    assert.equal(f.c.state.combat.entities[id].hp, hp)
    assert.equal(f.c.state.combat.entities[id].sp, 0)
    f.del('910')
    f.packets.length = 0
    f.add('911', byFlags(7), id, '5000', '200000')
    advanceArenaPetAI(f.c)
    const cast = f.packets.find((packet) => packet.name === 'SCProtoSkillStartSync' && packet.data.unit_id === id)
    assert.equal(cast.data.skill.slot, 2, 'CannotAttack freezes slot1, not the second skill')
    assert.ok(!f.packets.some((packet) => packet.name === 'SCProtoKiboStartMove' && packet.data.uuid === id))
})

test('native low-HP target preference overrides sticky nearest targets, and deleting a lock element disables selection without restoring an older layer', () => {
    const f = context(),
        [near, middle, low] = f.enemies
    f.c.state.combat.entities[near.uuid].hp = 200
    f.c.state.combat.entities[middle.uuid].hp = 100
    f.c.state.combat.entities[low.uuid].hp = 20
    f.run().pet_ai = {
        [f.self.uuid]: {
            locked: true,
            target: near.uuid,
            cooldowns: {},
            groups: {},
            ready_at: 100000,
            gcd_until: 99999999,
        },
    }
    f.add('920', 51020001)
    advanceArenaPetAI(f.c)
    assert.equal(f.run().pet_ai[f.self.uuid].target, low.uuid)
    f.add('921', 5102001)
    assert.ok(arenaLockSelector(f.c, f.self.uuid))
    f.del('920')
    assert.equal(
        arenaLockSelector(f.c, f.self.uuid),
        null,
        'OnReset clears the open flag even if another lock element exists',
    )
})

test('only-select masks use pet kiboType, choose no invalid fallback lock, and measure target range in3D', () => {
    const f = context(),
        [front, type4, type5] = f.enemies
    const category = (type) => tables.get('pet').find((pet) => pet.kiboType === type).id
    front.config_id = category(1)
    type4.config_id = category(4)
    type5.config_id = category(5)
    f.add('930', 51020050)
    const preference = arenaPriorityTarget(f.c, f.self, [front, type4, type5], 10)
    assert.equal(preference.only_select, true)
    assert.equal(preference.target, type5, 'property0 updates the candidate on each eligible list entry')
    f.run().in_fight[type4.uuid].move.pos.y += 1100
    f.run().in_fight[type5.uuid].move.pos.y += 1100
    const none = arenaPriorityTarget(f.c, f.self, [front, type4, type5], 10)
    assert.equal(none.target, undefined)
    assert.equal(none.only_select, true)
    // Type4/5 rows have no valid arena ultimate. Use the real NPC roster for
    // the full AI assertion instead of inventing combat skills for them.
    const actual = context()
    actual.add('930', 51020050)
    actual.c.now = 101
    advanceArenaPetAI(actual.c)
    assert.equal(actual.run().pet_ai[actual.self.uuid].locked, false)
    assert.ok(
        !actual.packets.some(
            (packet) => packet.name === 'SCProtoSkillStartSync' && packet.data.unit_id === actual.self.uuid,
        ),
    )
})

test('pause preserves control expiry and duplicate factual timestamps; card return removes native frozen presets', () => {
    const f = context(),
        id = f.self.uuid
    f.add('940', 50300011)
    updateNpcArenaPause(f.c, { operate: true, game_time: '100000' })
    f.c.state.world.pause = { operate: true, game_time: '100000', updated_at: 100 }
    f.c.now = 120
    assert.equal(arenaControlState(f.c, id).can_move, false)
    updateNpcArenaPause(f.c, { operate: false, game_time: '120000' })
    f.c.state.world.pause = { operate: false, game_time: '120000', updated_at: 120 }
    f.add('940', 50300011)
    assert.equal(f.run().controls['940'].expires_ms, '125000')
    const originalRaw = f.c.state.combat.elements
    const draft = { ...f.c, state: { ...f.c.state, combat: { ...f.c.state.combat } } }
    clearArenaCardControls(draft, id)
    assert.ok(originalRaw['940'], 'a card operation draft must not remove a live element through a shared map')
    assert.equal(draft.state.combat.elements['940'], undefined)
    clearArenaCardControls(f.c, id)
    assert.equal(arenaControlState(f.c, id).can_move, true)
})

test('real control reports use the compressed config ID and roll back flags, paths and elements on packet faults without SQLite writes', () => {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now }),
        session = {}
    const call = (name, request = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, request) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-control-protocol' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        const actor = Object.values(state().combat.npcDuel.actors).find((actor) => actor.camp === 1)
        store.transact(session.id, 0, (s) => {
            s.combat.npcDuel.pet_ai = { [actor.uuid]: { moving: true } }
        })
        const request = {
            base_time: String(now * 1000),
            uint64_dic: [actor.uuid, '901', '50300011'],
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        tar_id: '1',
                        uniqueId: '2',
                        buff: { cfg_id: 3, begin_time: '0', total_time: '5000', layer: 1 },
                    },
                },
            ],
        }
        const before = state(),
            writes = store.db.prepare('SELECT total_changes() AS n').get().n,
            original = game.packet
        game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboStopMove') throw Error('control stop packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('BattleInfoReduce', request), /control stop packet fault/)
        game.packet = original
        assert.deepEqual(state(), before)
        call('BattleInfoReduce', request)
        assert.equal(state().combat.npcDuel.controls['901'].config_id, 50300011)
        assert.equal(state().combat.npcDuel.pet_ai[actor.uuid].moving, false)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
    } finally {
        store.close()
    }
})

test('control rebuild uses the local-execution branch, preserves uint64 fields and cannot refresh the original deadline through its echo', () => {
    const f = context(),
        id = '9007199254740993',
        attacker = f.enemies[0].uuid
    f.add(id, 50300011, f.self.uuid, '4000')
    const raw = f.c.state.combat.elements[id]
    Object.assign(raw.buff, {
        attacker_id: attacker,
        executor_id: f.self.uuid,
        source_id: attacker,
        entrys: [{ key: 3, ui64_dic_values: [attacker, f.self.uuid] }],
    })
    const original = structuredClone(raw)
    f.c.now = 101
    publishArenaControls(f.c)
    const packet = f.packets.find((p) => p.name === 'SCProtoBattleInfoReduceNtf').data
    const restored = receivedElements(packet)[0]
    assert.equal(restored.op, 10)
    assert.equal(restored.uniqueId, id)
    assert.equal(restored.tar_id, f.self.uuid)
    assert.equal(restored.buff.attacker_id, attacker)
    assert.equal(restored.buff.cfg_id, 50300011)
    assert.equal(restored.buff.begin_time, '100000')
    assert.deepEqual(restored.buff.entrys[0].ui64_dic_values, [attacker, f.self.uuid])
    assert.deepEqual(raw, original)
    publishArenaControls(f.c)
    assert.equal(f.packets.filter((p) => p.name === 'SCProtoBattleInfoReduceNtf').length, 1)
    const echo = { ...structuredClone(original), buff: { ...structuredClone(original.buff), begin_time: '102000' } }
    f.c.now = 102
    f.c.state.combat.elements[id] = echo
    recordArenaControlEvent(f.c, echo)
    assert.equal(f.run().controls[id].expires_ms, '104000')
    f.c.now = 104
    advanceArenaControls(f.c)
    const ended = receivedElements(f.packets.filter((p) => p.name === 'SCProtoBattleInfoReduceNtf').at(-1).data)[0]
    assert.equal(ended.op, 2)
    assert.equal(ended.uniqueId, id)
    assert.equal(ended.buff.executor_id, f.self.uuid)
    assert.equal(f.run().control_replays[id].ended, true)
    f.c.state.combat.elements[id] = echo
    recordArenaControlEvent(f.c, echo)
    assert.equal(f.run().controls[id], undefined)
    assert.equal(f.c.state.combat.elements[id], undefined)
})

test('rebuild neither invents an attacker nor reopens a selector disabled by a different element reset', () => {
    const f = context()
    f.add('950', 50300011)
    const warnings = [],
        warn = console.warn
    try {
        console.warn = (...args) => warnings.push(args)
        publishArenaControls(f.c)
    } finally {
        console.warn = warn
    }
    assert.equal(warnings.length, 1)
    assert.equal(f.run().control_replay_missing_sources, 1)
    assert.ok(!f.packets.some((p) => p.name === 'SCProtoBattleInfoReduceNtf'))
    const g = context()
    g.add('951', 51020001)
    g.add('952', 5102001)
    g.del('951')
    publishArenaControls(g.c)
    assert.ok(!g.packets.some((p) => p.name === 'SCProtoBattleInfoReduceNtf'))
})

test('returning a rebuilt frozen pet retires its replay and a delayed add acknowledgement cannot resurrect it', () => {
    const f = context(),
        id = '960'
    f.add(id, 50300011, f.self.uuid, '4000')
    f.c.state.combat.elements[id].buff.attacker_id = f.enemies[0].uuid
    const echo = structuredClone(f.c.state.combat.elements[id])
    publishArenaControls(f.c)
    clearArenaCardControls(f.c, f.self.uuid)
    assert.equal(f.run().control_replays[id].ended, true)
    f.c.state.combat.elements[id] = echo
    recordArenaControlEvent(f.c, echo)
    assert.equal(f.run().controls[id], undefined)
})

test('actual reconnect waits for entity readiness, rebuilds controls once and explicitly ends their original remaining duration', () => {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now })
    const call = (name, data = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, data) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-control-reload' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        call('ControlMapAI', { control_type: 0, status: 1 })
        const actors = Object.values(state().combat.npcDuel.actors),
            self = actors.find((a) => a.camp === 1),
            enemy = actors.find((a) => a.camp === 2)
        const report = () =>
            call('BattleInfoReduce', {
                base_time: String(now * 1000),
                uint64_dic: [self.uuid, enemy.uuid, '970', '50300011'],
                battle_info: [
                    {
                        element_info: {
                            op: 1,
                            tar_id: '1',
                            uniqueId: '3',
                            buff: {
                                cfg_id: 4,
                                attacker_id: '2',
                                executor_id: '1',
                                begin_time: '0',
                                total_time: '4000',
                                layer: 1,
                            },
                        },
                    },
                ],
            })
        report()
        const expires = state().combat.npcDuel.controls['970'].expires_ms
        now += 1
        session = {}
        call('EnterGame', { open_id: 'npc-control-reload' })
        assert.ok(!call('MultiCampaignPlayerLoaded').some((p) => p.id === 10706))
        const beforeReady = state(),
            original = game.packet
        game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('control rebuild packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('MultiCampaignPlayerLoadFinish'), /control rebuild packet fault/)
        game.packet = original
        assert.deepEqual(state(), beforeReady)
        const ready = call('MultiCampaignPlayerLoadFinish')
        const row = receivedElements(ready.find((p) => p.id === 10706).data)[0]
        assert.equal(row.op, 10)
        assert.equal(row.buff.executor_id, self.uuid)
        assert.ok(!call('MultiCampaignPlayerLoadFinish').some((p) => p.id === 10706))
        const writes = store.db.prepare('SELECT total_changes() AS n').get().n
        now += 1
        report()
        assert.equal(state().combat.npcDuel.controls['970'].expires_ms, expires)
        now = Number(expires) / 1000
        const beforeEnd = state()
        game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('control end packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => game.tick(session.id, session), /control end packet fault/)
        game.packet = original
        assert.deepEqual(state(), beforeEnd)
        const ended = game
            .tick(session.id, session)
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
        assert.equal(receivedElements(ended.find((p) => p.id === 10706).data)[0].op, 2)
        report()
        assert.equal(state().combat.npcDuel.controls['970'], undefined)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
    } finally {
        store.close()
    }
})

test('a visible live taunter overrides nearest and low-HP policies without the ordinary acquisition radius', () => {
    const f = context(),
        [near, low, taunter] = f.enemies,
        id = f.self.uuid
    f.c.state.combat.entities[near.uuid].hp = 200
    f.c.state.combat.entities[low.uuid].hp = 1
    f.run().in_fight[taunter.uuid].move.pos.z += 3000
    f.add('980', 51020001)
    f.add('981', byFlags(8), id, '5000', '100000', taunter.uuid)
    assert.equal(arenaTauntTarget(f.c, id), taunter)
    advanceArenaPetAI(f.c)
    assert.equal(f.run().pet_ai[id].target, taunter.uuid)
    assert.equal(f.run().pet_ai[id].locked, true)
    const shown = f.run().in_fight[taunter.uuid]
    delete f.run().in_fight[taunter.uuid]
    assert.equal(arenaTauntTarget(f.c, id), null)
    advanceArenaPetAI(f.c)
    assert.equal(f.run().pet_ai[id].target, low.uuid)
    f.run().in_fight[taunter.uuid] = shown
    f.c.state.combat.entities[taunter.uuid].hp = 0
    assert.equal(arenaTauntTarget(f.c, id), null)
})

test('taunt reset clears the target without restoring older effects, and reconnect cannot reactivate a cleared selector', () => {
    const f = context(),
        id = f.self.uuid,
        config = byFlags(8)
    f.add('982', config, id, '5000', '100000', f.enemies[0].uuid)
    f.add('983', config, id, '5000', '100000', f.enemies[1].uuid)
    assert.equal(arenaTauntTarget(f.c, id), f.enemies[1])
    f.del('982')
    assert.equal(arenaTauntTarget(f.c, id), null)
    publishArenaControls(f.c)
    assert.ok(!f.packets.some((p) => p.name === 'SCProtoBattleInfoReduceNtf'))
    f.add('984', config, id, '5000', '100000', f.enemies[0].uuid)
    f.add('985', config, id)
    assert.equal(
        arenaTauntTarget(f.c, id),
        f.enemies[0],
        'a missing attacker cannot replace the existing native taunt target',
    )
    f.c.now = 105
    advanceArenaControls(f.c)
    assert.equal(arenaTauntTarget(f.c, id), null)
})
