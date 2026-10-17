import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPetAttributes } from '../src/kibo-arena-attributes.js'
import { initializeNpcDuelBattle, setArenaInFight } from '../src/npc-kibo-battle.js'
import {
    arenaSpConfig,
    arenaPassiveSpStep,
    advanceArenaSp,
    publishArenaSp,
    recordArenaSkillStart,
    recordArenaSkillStop,
    recordArenaPropertyChange,
} from '../src/npc-kibo-sp.js'
import { updateNpcArenaPause } from '../src/npc-kibo-pause.js'
import { arenaProperty, mergeArenaProperties } from '../src/npc-kibo-properties.js'
import { advanceArenaPetAI } from '../src/npc-kibo-pet-ai.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

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
    const self = Object.values(run.actors).find((actor) => actor.camp === 1),
        enemy = Object.values(run.actors).find((actor) => actor.camp === 2)
    run.in_fight = {
        [self.uuid]: { move: { pos: { x: 13000, y: 9995, z: 14090 }, angle: 0 }, entered_at: 100 },
        [enemy.uuid]: { move: { pos: { x: 13000, y: 9995, z: 14400 }, angle: 180 }, entered_at: 100 },
    }
    const packets = [],
        c = {
            state,
            tables,
            now: 100,
            randomInt: (lo) => lo,
            pushBefore: (name, data) => {
                const entry = p.byName.get(name)
                packets.push({ id: entry.id, data: p.decode(entry.rsp, p.encode(entry.rsp, data)) })
            },
        }
    return {
        c,
        self,
        enemy,
        packets,
        run: () => state.combat.npcDuel,
        sp: (uuid) => state.combat.entities[uuid].sp,
        tick: (now) => {
            c.now = now
            packets.length = 0
            advanceArenaSp(c)
            advanceArenaPetAI(c)
            publishArenaSp(c)
            return packets
        },
    }
}

test('SP init, cap and ordinary cast gains follow every NPC pet configuration', () => {
    const ids = new Set(
        tables
            .get('kibo_duel')
            .filter((row) => tables.find('kibo_duel_map', row.mapId))
            .flatMap((row) => row.enemy.split('|').filter(Boolean).map(Number)),
    )
    for (const id of ids) {
        const config = arenaSpConfig(tables, id)
        assert.ok(config.max > 0)
        assert.equal(config.initial, 0)
        assert.equal(config.passive, 20)
        assert.equal(config.ultimate.skill_slot, 206)
        assert.equal(
            Number(arenaPetAttributes(tables, id, 1).attrs.attrs.find((attr) => attr.attr_id === 6).attr_val),
            config.max * 10000,
        )
        assert.ok(
            config.skills
                .filter((skill) => [1, 2].includes(skill.skill_slot))
                .every((skill) => skill.logic.kiBoAttackSp > 0),
        )
    }
    const f = context()
    const packets = f.tick(101)
    assert.equal(f.sp(f.self.uuid), 59, 'ten Q16 passive steps plus40 once at ordinary slot1 start')
    assert.ok(packets.findIndex((packet) => packet.id === 11101) < packets.findIndex((packet) => packet.id === 10009))
    const cast = f.run().arena_casts[f.self.uuid]
    recordArenaSkillStart(f.c, f.self.uuid, {
        skill: { skill_id: cast.skill_id },
        op_time: '101000',
        verify_info: { source_type: 5, battle_index: '17' },
    })
    assert.equal(f.sp(f.self.uuid), 59, 'network source5 acknowledges the server cast without another gain')
    assert.equal(f.run().arena_casts[f.self.uuid].network_index, '17')
})

test('full energy selects206, spends kiBoSpMax, and waits for the matching actual skill stop', () => {
    const f = context(),
        config = arenaSpConfig(tables, f.self.config_id)
    f.tick(101)
    f.run().ultra_choices = { [f.self.source_guid]: false }
    const now = 100 + Math.ceil(config.max / config.passive) + 2
    const packets = f.tick(now)
    const skill = packets.find((packet) => packet.id === 11101 && packet.data.unit_id === f.self.uuid).data.skill
    assert.equal(skill.slot, 206)
    assert.equal(skill.skill_id, config.ultimate.skill_id)
    const castIndex = packets.findIndex((packet) => packet.id === 11101 && packet.data.unit_id === f.self.uuid)
    assert.equal(
        packets
            .slice(0, castIndex)
            .some(
                (packet) =>
                    packet.id === 10009 &&
                    packet.data.infos.some((info) => info.uuid === f.self.uuid && info.sp === config.max),
            ),
        false,
        'native OnSyncStartSkill executes the paid cast without a full-SP prerequisite packet',
    )
    assert.ok(
        packets
            .slice(castIndex + 1)
            .some(
                (packet) =>
                    packet.id === 10009 && packet.data.infos.some((info) => info.uuid === f.self.uuid && info.sp === 0),
            ),
    )
    assert.equal(f.sp(f.self.uuid), 0)
    recordArenaSkillStart(f.c, f.self.uuid, { skill, verify_info: { source_type: 5, battle_index: '18' } })
    assert.ok(!f.tick(now + 1).some((packet) => packet.id === 11101 && packet.data.unit_id === f.self.uuid))
    recordArenaSkillStop(f.c, f.self.uuid, { skill_id: String(skill.skill_id), verify_info: { related_index: '17' } })
    assert.equal(f.run().arena_casts[f.self.uuid].ended, false)
    recordArenaSkillStop(f.c, f.self.uuid, { skill_id: String(skill.skill_id), verify_info: { related_index: '18' } })
    assert.equal(f.run().arena_casts[f.self.uuid].ended, true)
    assert.ok(
        f
            .tick(now + 2)
            .some(
                (packet) =>
                    packet.id === 11101 && packet.data.unit_id === f.self.uuid && packet.data.skill.slot !== 206,
            ),
    )
})

test('a delayed client cast retry stays paid after another skill replaced the active animation', () => {
    const f = context(),
        config = arenaSpConfig(tables, f.self.config_id),
        id = f.self.uuid
    f.c.now = 150
    advanceArenaSp(f.c)
    const request = {
        skill: { skill_id: config.ultimate.skill_id },
        op_time: '150000',
        verify_info: { source_type: 0, battle_index: '4294971462' },
    }
    recordArenaSkillStart(f.c, id, request)
    assert.equal(f.sp(id), 0)
    recordArenaSkillStop(f.c, id, {
        skill_id: String(config.ultimate.skill_id),
        verify_info: { related_index: '4294971462' },
    })
    const ordinary = config.skills.find((skill) => skill.skill_slot === 1)
    recordArenaSkillStart(f.c, id, {
        skill: { skill_id: ordinary.skill_id },
        op_time: '150000',
        verify_info: { source_type: 0, battle_index: '4294971463' },
    })
    const before = structuredClone(f.c.state.combat)
    assert.doesNotThrow(() => recordArenaSkillStart(f.c, id, request))
    assert.deepEqual(f.c.state.combat, before, 'retry must neither debit again nor replace the newer animation')
    assert.throws(
        () =>
            recordArenaSkillStart(f.c, id, { ...request, verify_info: { source_type: 0, battle_index: '4294971464' } }),
        /energy is insufficient/,
        'a fresh unpaid ultimate still needs energy',
    )
})

test('an insufficient client ultimate preserves a bounded diagnostic of the rejected state', () => {
    const f = context(),
        config = arenaSpConfig(tables, f.self.config_id)
    const before = structuredClone(f.c.state.combat)
    assert.throws(
        () =>
            recordArenaSkillStart(f.c, f.self.uuid, {
                skill: { skill_id: config.ultimate.skill_id },
                op_time: '100000',
                verify_info: { source_type: 0, battle_index: '4294971462' },
            }),
        (error) => {
            assert.match(error.message, /energy is insufficient/)
            assert.equal(error.arenaSpContext.uuid, f.self.uuid)
            assert.equal(error.arenaSpContext.skill_id, config.ultimate.skill_id)
            assert.equal(error.arenaSpContext.available_milli, 0)
            assert.equal(error.arenaSpContext.cost_milli, config.max * 1000)
            assert.equal(error.arenaSpContext.source_type, 0)
            return true
        },
    )
    assert.deepEqual(f.c.state.combat.entities, before.entities)
    assert.equal(f.run().arena_casts?.[f.self.uuid], undefined)
})

test('hand cards, corpses, intro and world pause do not gain passive SP; retreat retains energy', () => {
    const f = context()
    f.tick(101)
    const before = f.sp(f.self.uuid),
        move = f.run().positions.selfSummon
    setArenaInFight(f.c, f.self, move, false)
    f.c.now = 105
    advanceArenaSp(f.c)
    assert.equal(f.sp(f.self.uuid), before)
    setArenaInFight(f.c, f.self, move, true)
    f.c.now = 106
    advanceArenaSp(f.c)
    assert.equal(f.sp(f.self.uuid), before + 20)
    f.c.state.world.pause = { operate: true, updated_at: 106 }
    f.c.now = 116
    advanceArenaSp(f.c)
    assert.equal(f.sp(f.self.uuid), before + 20)
    f.c.state.world.pause = { operate: false, updated_at: 116 }
    f.c.now = 117
    advanceArenaSp(f.c)
    assert.equal(f.sp(f.self.uuid), before + 40)
    f.c.state.multiCampaign.arena_status = 6
    f.c.now = 127
    advanceArenaSp(f.c)
    assert.equal(f.sp(f.self.uuid), before + 40)
    f.c.state.multiCampaign.arena_status = 4
    f.c.state.combat.entities[f.self.uuid] = { ...f.c.state.combat.entities[f.self.uuid], hp: 0, alive_state: 1 }
    advanceArenaSp(f.c)
    assert.equal(f.sp(f.self.uuid), before + 40)
    f.packets.length = 0
    publishArenaSp(f.c, true)
    assert.equal(f.packets[0].data.infos.find((info) => info.uuid === f.self.uuid).alive_state, 1)
})

const component = (attrId, type, value, tag = 0) => ({
    attrId,
    attr_values: [{ attr_type: type, value, attr_tag: tag }],
})
const propertyChange = (f, entries, uuid = f.self.uuid) =>
    recordArenaPropertyChange(f.c, { uuid, attrButeInfos: entries })

test('SP dynamic components replace per type/tag, retain other attributes, and normalize only on native ratio reads', () => {
    const f = context(),
        id = f.self.uuid
    propertyChange(f, [
        component(110, 3, 10),
        component(110, 4, 4),
        component(110, 5, 0.5),
        component(105, 4, 5000),
        component(227, 4, 10000),
    ])
    assert.equal(arenaProperty(f.c, id, 110, 0, false), 19)
    assert.equal(arenaProperty(f.c, id, 105), 0.5)
    assert.equal(arenaProperty(f.c, id, 227), 1)
    propertyChange(f, [component(110, 3, 10), component(110, 4, 200, 9)])
    assert.equal(arenaProperty(f.c, id, 110, 0, false), 19, 'retry is absolute and a tagged modifier is conditional')
    assert.equal(arenaProperty(f.c, id, 105), 0.5, 'partial packet retains a different prior attribute')
    propertyChange(f, [component(110, 3, 0), component(110, 4, 0)])
    assert.equal(arenaProperty(f.c, id, 110, 0, false), 0)
    propertyChange(f, [component(105, 4, -5000)])
    assert.equal(arenaProperty(f.c, id, 105), 0, 'battle_info minimum is applied')
    propertyChange(f, [component(110, 6, 7, 99)])
    assert.equal(arenaProperty(f.c, id, 110, 0, false), 7, 'force ignores tags and overrides the dynamic expression')
    propertyChange(f, [component(110, 6, -100000)])
    assert.equal(arenaProperty(f.c, id, 110, 0, false), 0, 'native force sentinel removes the override')
    propertyChange(f, [component(110, 3, 0.1), component(110, 5, 0.1)])
    assert.equal(
        arenaProperty(f.c, id, 110, 0, false),
        Math.fround(7208 / 65536),
        'Q16 multiplication follows MyFloat, not decimal multiplication',
    )
})

test('SP reports settle the previous rate before changing field, background and skill-gain modifiers', () => {
    const f = context(),
        id = f.self.uuid
    f.c.now = 101
    propertyChange(f, [component(110, 4, 10), component(227, 4, 10000), component(105, 4, 5000)])
    assert.equal(f.sp(id), 19, 'the preceding second uses ten Q16 steps at the original20 rate')
    f.c.now = 102
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 79, '(20 passive +10 field) * (1 +10000/10000), quantized each step')
    recordArenaSkillStart(f.c, id, {
        skill: { skill_id: arenaSpConfig(tables, f.self.config_id).skills.find((s) => s.skill_slot === 1).skill_id },
        verify_info: { battle_index: '100' },
    })
    assert.equal(f.sp(id), 139, 'ordinary skill40 is multiplied by1.5 SPGETUP, not by the passive multiplier')
    setArenaInFight(f.c, f.self, f.run().positions.selfSummon, false)
    propertyChange(f, [component(226, 4, 5)])
    f.c.now = 103
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 149, 'hand recovery uses background5, doubled, with no20 field passive')
    propertyChange(f, [component(226, 4, 0)])
    f.c.now = 104
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 149)
})

test('SP dynamic maximum caps energy while paused/dead actors never gain background recovery', () => {
    const f = context(),
        id = f.self.uuid
    propertyChange(f, [component(6, 6, 30), component(226, 4, 20)])
    f.c.now = 102
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 30)
    propertyChange(f, [component(6, 6, -100000)])
    setArenaInFight(f.c, f.self, f.run().positions.selfSummon, false)
    f.c.state.world.pause = { operate: true, updated_at: 102 }
    f.c.now = 112
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 30)
    f.c.state.world.pause = { operate: false, updated_at: 112 }
    f.c.state.combat.entities[id] = { ...f.c.state.combat.entities[id], hp: 0, alive_state: 1 }
    f.c.now = 122
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 30)
    const old = structuredClone(f.c.state)
    const draft = { ...f.c.state, combat: { ...f.c.state.combat } }
    assert.throws(
        () =>
            mergeArenaProperties(
                { ...f.c, state: draft },
                { uuid: id, attrButeInfos: [component(110, 4, 99), component(105, 4, Infinity)] },
            ),
        /Invalid arena property/,
    )
    assert.deepEqual(f.c.state, old, 'failed draft never mutates nested component maps')
})

test('live protocol casts are paid once, roll back on packet faults and do not immediately write SQLite', () => {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now })
    const decode = (packets) =>
        packets.map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    const call = (name, data = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return decode(game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, data) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'arena-sp-protocol' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', 501).dungeonId })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        for (const uuid of Object.keys(state().combat.npcDuel.in_fight))
            call('KiboCastUltraSkill', { guid: uuid, cast_ultra_skill: false })
        call('ControlMapAI', { control_type: 0, status: 1 })
        const actor = Object.values(state().combat.npcDuel.actors).find(
            (actor) => actor.camp === 1 && state().combat.npcDuel.in_fight[actor.uuid],
        )
        const config = arenaSpConfig(tables, actor.config_id)
        const writes = store.db.prepare('SELECT total_changes() AS n').get().n
        now += Math.ceil(config.max / config.passive) + 1
        game.tick(session.id, session)
        assert.equal(state().combat.entities[actor.uuid].sp, config.max)
        const request = {
            unit_id: actor.uuid,
            skill: { skill_id: config.ultimate.skill_id, slot: 206 },
            verify_info: { source_type: 1, battle_index: '999' },
        }
        const snapshot = structuredClone(state().combat),
            originalPacket = game.packet
        game.packet = function (name, ...rest) {
            if (name === 'CSProtoObjBattleInfoSync') throw Error('SP packet fault')
            return originalPacket.call(this, name, ...rest)
        }
        assert.throws(() => call('SkillStart', request), /SP packet fault/)
        game.packet = originalPacket
        assert.deepEqual(state().combat, snapshot)
        call('KiboCastUltraSkill', { guid: actor.uuid, cast_ultra_skill: true })
        call('SkillStart', request)
        assert.equal(state().combat.entities[actor.uuid].sp, 0)
        assert.equal(state().combat.npcDuel.entry_reports[actor.uuid].consumed, true)
        call('SkillStart', request)
        assert.equal(state().combat.entities[actor.uuid].sp, 0)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        call('SkillStop', {
            unit_id: actor.uuid,
            skill_id: String(config.ultimate.skill_id),
            verify_info: { related_index: '999' },
        })
        assert.equal(state().combat.npcDuel.arena_casts[actor.uuid].ended, true)
        const report = (entries) =>
            call('BattleInfoReduce', {
                battle_info: [{ attr_change: { uuid: actor.uuid, attrButeInfos: entries } }],
            })
        now += 2
        report([component(110, 4, 100), component(227, 4, 10000)])
        assert.equal(
            state().combat.entities[actor.uuid].sp,
            39,
            'report settles the old rate before applying modifiers',
        )
        now += 1
        game.tick(session.id, session)
        assert.equal(state().combat.entities[actor.uuid].sp, 279)
        const attributeSnapshot = structuredClone(state().combat)
        assert.throws(() => report([component(110, 4, 999), component(105, 4, Infinity)]), /Invalid arena property/)
        assert.deepEqual(state().combat, attributeSnapshot)
        game.packet = function (name, ...rest) {
            if (name === 'CSProtoObjBattleInfoSync') throw Error('attribute SP packet fault')
            return originalPacket.call(this, name, ...rest)
        }
        now += 1
        assert.throws(() => report([component(110, 4, 111)]), /attribute SP packet fault/)
        game.packet = originalPacket
        assert.deepEqual(state().combat, attributeSnapshot)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const properties = structuredClone(state().combat.entities[actor.uuid].arena_properties)
        const ordinary = config.skills.find((skill) => skill.skill_slot === 1)
        call('SkillStart', {
            unit_id: actor.uuid,
            skill: { skill_id: ordinary.skill_id },
            verify_info: { source_type: 0, battle_index: '1000' },
        })
        const afterOrdinary = structuredClone(state().combat)
        call('SkillStart', request)
        assert.deepEqual(
            state().combat,
            afterOrdinary,
            'a delayed paid cast retry must not overwrite skill history or origins, or debit energy again',
        )
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        session = {}
        call('EnterGame', { open_id: 'arena-sp-protocol' })
        assert.equal(state().multiCampaign, undefined)
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        assert.deepEqual(state().combat.npcDuel.arena_casts, {}, 'new entity creation clears old animation lifetimes')
        assert.deepEqual(
            state().combat.npcDuel.arena_cast_receipts,
            {},
            'client entity rebuild begins a new cast-index lifetime',
        )
        assert.ok(properties)
        assert.equal(
            state().combat.entities[actor.uuid],
            undefined,
            'a new challenge retires old property components with their actors',
        )
        const newActor = Object.values(state().combat.npcDuel.actors).find(
            (row) => row.source_guid === actor.source_guid,
        )
        assert.equal(state().combat.entities[newActor.uuid].arena_properties, undefined)
        const ready = call('MultiCampaignPlayerLoadFinish')
        assert.ok(
            ready.some(
                (packet) => packet.id === 10009 && packet.data.infos.some((info) => info.uuid === newActor.uuid),
            ),
        )
    } finally {
        store.close()
    }
})

test('passive SP first fires at100ms and each step uses native Q16 then float multiplication', () => {
    const f = context(),
        id = f.self.uuid
    const advance = (ms) => {
        f.c.arena_now_ms = 100000 + ms
        advanceArenaSp(f.c)
    }
    assert.equal(arenaPassiveSpStep(f.c, id, true), 1.99981689453125)
    advance(0)
    advance(99)
    assert.equal(f.run().pet_sp[id].milli, 0)
    advance(100)
    assert.equal(f.run().pet_sp[id].milli, 1999.81689453125)
    assert.equal(f.sp(id), 1)
    advance(199)
    assert.equal(f.run().pet_sp[id].milli, 1999.81689453125)
    advance(200)
    assert.equal(f.run().pet_sp[id].milli, 3999.6337890625)
    propertyChange(f, [component(227, 4, 5000)])
    assert.equal(arenaPassiveSpStep(f.c, id, true), 2.999725341796875)
    advance(300)
    assert.equal(f.run().pet_sp[id].milli, 6999.359130859375)
})

test('substep property updates use the new rate at the next step without prorating or restarting its phase', () => {
    const f = context(),
        id = f.self.uuid
    f.c.arena_now_ms = 100050
    propertyChange(f, [component(110, 4, 10)])
    assert.equal(f.run().pet_sp[id].remainder_ms, 50)
    assert.equal(f.sp(id), 0)
    f.c.arena_now_ms = 100099
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 0)
    f.c.arena_now_ms = 100100
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 2999.725341796875)
    f.c.arena_now_ms = 100150
    propertyChange(f, [component(110, 4, 0)])
    f.c.arena_now_ms = 100200
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 4999.542236328125)
})

test('retreat settles the previous field state and background recovery preserves the100ms phase on reentry', () => {
    const f = context(),
        id = f.self.uuid,
        move = f.run().positions.selfSummon
    propertyChange(f, [component(226, 4, 5)])
    f.c.arena_now_ms = 100150
    setArenaInFight(f.c, f.self, move, false)
    assert.equal(f.run().pet_sp[id].milli, 1999.81689453125)
    assert.equal(f.run().pet_sp[id].remainder_ms, 50)
    f.c.arena_now_ms = 100250
    setArenaInFight(f.c, f.self, move, true)
    assert.equal(f.run().pet_sp[id].milli, 2499.7711181640625)
    f.c.arena_now_ms = 100300
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 4499.5880126953125)
})

test('locked passive steps are discarded and recovery resumes on the original step boundary', () => {
    const f = context(),
        id = f.self.uuid
    f.run().pet_sp = { [id]: { milli: 0, at: 100000, lock_until: 100250 } }
    f.c.arena_now_ms = 100249
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 0)
    f.c.arena_now_ms = 100250
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 0, 'unlock does not award a fractional passive step')
    f.c.arena_now_ms = 100300
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 1999.81689453125)
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 1999.81689453125)
    f.c.arena_now_ms = 100200
    advanceArenaSp(f.c)
    f.c.arena_now_ms = 100399
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 1999.81689453125, 'backward time cannot restart a step')
    f.c.arena_now_ms = 100400
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 3999.6337890625)
})

test('arena pause preserves a partial SP step and does not accumulate paused recovery', () => {
    const f = context(),
        id = f.self.uuid
    f.c.arena_now_ms = 100050
    const pause = { operate: true, game_time: '100050' }
    updateNpcArenaPause(f.c, pause)
    f.c.state.world.pause = { ...pause, updated_at: 100.05 }
    f.c.arena_now_ms = 200050
    updateNpcArenaPause(f.c, { operate: false, game_time: '200050' })
    f.c.state.world.pause = { operate: false, game_time: '200050', updated_at: 200.05 }
    assert.equal(f.run().pet_sp[id].remainder_ms, 50)
    f.c.arena_now_ms = 200099
    advanceArenaSp(f.c)
    assert.equal(f.sp(id), 0)
    f.c.arena_now_ms = 200100
    advanceArenaSp(f.c)
    assert.equal(f.run().pet_sp[id].milli, 1999.81689453125)
})

test('batched and fine passive polls have identical quantization and legacy clocks retain the match phase', () => {
    const fine = context(),
        batch = context(),
        id = fine.self.uuid
    for (let ms = 17; ms < 3000; ms += 17) {
        fine.c.arena_now_ms = 100000 + ms
        advanceArenaSp(fine.c)
    }
    fine.c.arena_now_ms = 103000
    batch.c.arena_now_ms = 103000
    advanceArenaSp(fine.c)
    advanceArenaSp(batch.c)
    assert.equal(fine.run().pet_sp[id].milli, 59994.5068359375)
    assert.equal(fine.run().pet_sp[id].milli, batch.run().pet_sp[id].milli)
    assert.equal(fine.run().pet_sp[id].remainder_ms, 0)
    delete batch.run().pet_sp[id].remainder_ms
    batch.run().pet_sp[id].at = 103050
    batch.c.arena_now_ms = 103099
    advanceArenaSp(batch.c)
    assert.equal(batch.run().pet_sp[id].milli, 59994.5068359375)
    batch.c.arena_now_ms = 103100
    advanceArenaSp(batch.c)
    assert.equal(batch.run().pet_sp[id].milli, 61994.32373046875)
})
