import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPetAttributes, arenaSkillLevels } from '../src/kibo-arena-attributes.js'
import { initializeNpcDuelBattle } from '../src/npc-kibo-battle.js'
import { mergeArenaProperties, arenaProperty } from '../src/npc-kibo-properties.js'
import { arenaExecutionProperty, arenaExecutionResource } from '../src/npc-kibo-execution-properties.js'
import { arenaSnapshotView, bindArenaSnapshot, releaseArenaSnapshot } from '../src/npc-kibo-snapshots.js'
import {
    arenaFormulaEntity,
    arenaExecutionFormulaContext,
    arenaExecutionFormula,
} from '../src/npc-kibo-formula-context.js'
import { evaluateArenaFormula } from '../src/npc-kibo-formulas.js'
import { resetArenaOrigins, recordArenaElementOrigin, recordArenaSkillOrigin } from '../src/npc-kibo-origins.js'
import {
    arenaDamageElement,
    arenaElementParameter,
    recordArenaDamageElement,
    arenaDamageInput,
    arenaDamageRecord,
    arenaDamageRecoveryPath,
    arenaElementExecutionInput,
} from '../src/npc-kibo-damage-inputs.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
const catalog = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-damage.json', import.meta.url), 'utf8'))
function context() {
    const data = arenaPetAttributes(tables, 500020, 5)
    const skill = data.skills
        .flatMap((module) => module.sub_modules)
        .flatMap((sub) => sub.skills.skills)
        .find((skill) => skill.skill_id === 5030012)
    skill.skill_lv = 3
    const state = {
        player: { basic_info: { id: 1 } },
        world: { map_id: 1052 },
        multiCampaign: { duel_id: 501, map_id: 1052, start_time: 100, arena_status: 4 },
    }
    const run = initializeNpcDuelBattle(
        tables,
        state,
        {
            hero_info: { hero_guid: '123' },
            infos: [{ pet_guid: { guid: '456' }, pet_conf_id: 500020, pet_lv: 5, ...data }],
        },
        100,
    )
    const self = Object.values(run.actors).find((row) => row.camp === 1),
        enemy = Object.values(run.actors).find((row) => row.camp === 2)
    const c = { state, tables, now: 100 }
    const event = (uid, config = 503001101, extra = {}) => ({
        op: 1,
        uniqueId: uid,
        tar_id: enemy.uuid,
        clientTmpID: 100,
        buff: { cfg_id: config, attacker_id: self.uuid, source_id: self.uuid, damage_cri_pct: 0, begin_time: '100000' },
        ...extra,
    })
    return { c, self, enemy, event }
}

test('actual normal/DOT input catalog preserves aliases and refuses conflicting client IDs', () => {
    assert.equal(catalog.root_assets, 7652)
    assert.equal(Object.keys(catalog.elements).length, 7644)
    assert.deepEqual(Object.keys(catalog.conflicts).map(Number).sort(), [400065986, 500399005])
    assert.equal(arenaDamageElement(503001101).formula_id, 101)
    assert.deepEqual(arenaDamageElement(503001101).tags, [22, 35, 309])
    assert.equal(catalog.elements[310839025].sources.length, 2)
    assert.equal(arenaDamageElement(400065986), null)
    assert.throws(() => arenaElementParameter(tables, 500399005, 0, 1, 0), /Ambiguous/)
})

test('native parameter lookup uses exact element/skill/level, last repeated row, one-based keys and zero fallback', () => {
    assert.equal(arenaElementParameter(tables, 500022070, 50002208, 1, 0), 18130)
    assert.equal(
        arenaElementParameter(tables, 500022070, 50002208, 2, 0),
        3500,
        'missing level uses the asset, never the nearest row',
    )
    assert.equal(arenaElementParameter(tables, 503001101, 5030012, 1, 5), 10000)
    assert.equal(arenaElementParameter(tables, 503001101, 5030012, 1, 99), 0)
    const custom = {
        get: (name) => {
            assert.equal(name, 'skillsub_ele_value')
            return [{ elementId: 503001101, skillId: 5030012, level: 7, valueParam: '1#0|2#3' }]
        },
    }
    assert.equal(
        arenaElementParameter(custom, 503001101, 5030012, 7, 0),
        0,
        'explicit zero override does not fall through',
    )
    assert.equal(arenaElementParameter(custom, 503001101, 5030012, 7, 1), 3)
    assert.throws(() => arenaElementParameter(tables, 503001101, 5030012, 1, -1), /parameter index/)
})

test('source skill levels follow native immediate child propagation and later wire module replacement', () => {
    const child = tables.get('skill').find((row) => row.parentSkill > 0 && row.parentSkill !== row.id)
    const module = (skill_id, skill_lv) => ({ sub_modules: [{ skills: { skills: [{ skill_id, skill_lv }] } }] })
    const levels = arenaSkillLevels(tables, [module(child.parentSkill, 7)])
    assert.equal(levels[child.id], 7)
    assert.equal(levels[child.parentSkill], 7)
    const replaced = arenaSkillLevels(tables, [module(child.parentSkill, 7), module(child.id, 2)])
    assert.equal(replaced[child.id], 2)
    assert.equal(replaced[child.parentSkill], 7)
    const sample = {
        get: () => [
            { id: 2, parentSkill: 1 },
            { id: 3, parentSkill: 2 },
            { id: 4, parentSkill: 4 },
        ],
    }
    assert.deepEqual(arenaSkillLevels(sample, [module(1, 5)]), { 1: 5, 2: 5 })
})

test('damage contexts join exact uint64 UID and target-local temp ID, retaining frozen source skill levels', () => {
    const f = context(),
        uid = '9007199254740993'
    recordArenaDamageElement(f.c, f.event(uid))
    assert.equal(f.self.skill_levels[5030012], 3)
    const hurt = {
        tar_id: f.enemy.uuid,
        from_id: f.self.uuid,
        element_uniqueId: uid,
        element_tempId: 100,
        skill_id: 5030012,
    }
    const input = arenaDamageInput(f.c, hurt)
    assert.equal(input.status, 'ready')
    assert.equal(input.level, 3)
    assert.equal(input.parameter(0), 2000)
    assert.equal(input.record.critical_random, 0)
    assert.equal(input.record.snapshot_mode, 'none')
    assert.equal(arenaDamageInput(f.c, { ...hurt, element_uniqueId: '0' }).record.id, uid)
    assert.equal(arenaDamageInput(f.c, { ...hurt, element_tempId: 101 }).status, 'element-not-found')
    assert.equal(arenaDamageInput(f.c, { ...hurt, tar_id: f.self.uuid }).status, 'element-not-found')
    delete f.c.state.combat.npcDuel.actors[f.self.uuid].skill_levels
    assert.equal(arenaDamageInput(f.c, hurt).status, 'source-skill-levels-unavailable')
})

test('independent snapshot input is captured once, and ended retries cannot replace it with later attributes', () => {
    const f = context(),
        uid = '902'
    const update = (value) =>
        mergeArenaProperties(f.c, {
            uuid: f.self.uuid,
            attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 4, value }] }],
        })
    update(30)
    const event = f.event(uid, 18009046)
    recordArenaDamageElement(f.c, event)
    const first = f.c.state.combat.npcDuel.damage_elements[uid]
    assert.equal(first.snapshot_mode, 'own')
    assert.equal(first.snapshots[f.self.uuid].base_properties, undefined, 'entry bases are stored once on the actor')
    const base = f.self.base_properties
    const value = () =>
        arenaProperty(f.c, f.self.uuid, 1, undefined, false, null, 0, {
            base_properties: base,
            ...f.c.state.combat.npcDuel.damage_elements[uid].snapshots[f.self.uuid],
        })
    const captured = value()
    update(100)
    recordArenaDamageElement(f.c, { ...event, buff: { ...event.buff, begin_time: '120000' } })
    assert.equal(value(), captured)
    assert.notEqual(arenaProperty(f.c, f.self.uuid, 1), captured)
    recordArenaDamageElement(f.c, { op: 2, uniqueId: uid, tar_id: f.enemy.uuid })
    recordArenaDamageElement(f.c, event)
    assert.equal(f.c.state.combat.npcDuel.damage_elements[uid].ended, true)
    assert.equal(value(), captured)
    const pending = f.event('903', 18009046, { parentUniqueId: '899' })
    recordArenaDamageElement(f.c, pending)
    assert.equal(
        arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '903' }).status,
        'inherited-snapshot-unresolved',
    )
})

test('context updates remain copy-on-write and a bounded delayed-hit cache survives element deletion', () => {
    const f = context(),
        old = structuredClone(f.c.state)
    const draft = { ...f.c, state: { ...f.c.state, combat: { ...f.c.state.combat } } }
    recordArenaDamageElement(draft, f.event('901'))
    assert.deepEqual(f.c.state, old)
    for (let i = 0; i < 514; i++)
        recordArenaDamageElement(f.c, f.event(String(10000 + i), 503001101, { clientTmpID: i + 1 }))
    assert.equal(Object.keys(f.c.state.combat.npcDuel.damage_elements).length, 512)
    assert.equal(f.c.state.combat.npcDuel.damage_elements['10000'], undefined)
    recordArenaDamageElement(f.c, { op: 2, uniqueId: '10513', tar_id: f.enemy.uuid })
    assert.equal(arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '10513' }).status, 'ready')
})

test('pre-execution attributes stay separate from native snapshots and DOT end damage selects its own formula vector', () => {
    const f = context()
    const update = (value) =>
        mergeArenaProperties(f.c, {
            uuid: f.self.uuid,
            attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 4, value }] }],
        })
    update(20)
    recordArenaDamageElement(f.c, f.event('910'))
    update(40)
    const run = () => f.c.state.combat.npcDuel
    assert.equal(run().damage_elements['910'].before_execution[f.self.uuid].arena_properties[1]['4:0'], 20)
    assert.equal(
        run().damage_elements['910'].snapshots,
        undefined,
        'execution observation is not a native snapshot flag',
    )
    recordArenaDamageElement(f.c, f.event('911', 14004))
    const snapshot = run().damage_elements['911'].snapshots
    update(80)
    recordArenaDamageElement(f.c, { op: 8, uniqueId: '911', tar_id: f.enemy.uuid, buff: { damage_cri_pct: 9000 } })
    assert.equal(run().damage_elements['911'].before_execution[f.self.uuid].arena_properties[1]['4:0'], 80)
    assert.deepEqual(run().damage_elements['911'].snapshots, snapshot)
    const hurt = { tar_id: f.enemy.uuid, element_uniqueId: '911', skill_id: 0 }
    assert.equal(arenaDamageInput(f.c, hurt).parameter(0), 400)
    recordArenaDamageElement(f.c, { op: 9, uniqueId: '911', tar_id: f.enemy.uuid })
    assert.equal(arenaDamageInput(f.c, hurt).parameter(0), 1200)
    assert.equal(arenaDamageInput(f.c, hurt).record.execution_kind, 'end')
})

test('the native recovery path distinguishes initial injection from DOT ticks/end, combines and unresolved rebuilds', () => {
    const f = context()
    recordArenaDamageElement(f.c, f.event('920', 14004))
    const record = () => f.c.state.combat.npcDuel.damage_elements['920']
    assert.equal(arenaDamageRecoveryPath(record()), 'initial-execution')
    recordArenaDamageElement(f.c, { op: 8, uniqueId: '920', tar_id: f.enemy.uuid })
    assert.equal(arenaDamageRecoveryPath(record()), 'none')
    recordArenaDamageElement(f.c, f.event('920', 14004))
    assert.equal(arenaDamageRecoveryPath(record()), 'none', 'a retry cannot manufacture another initial recovery path')
    recordArenaDamageElement(f.c, { op: 9, uniqueId: '920', tar_id: f.enemy.uuid })
    assert.equal(arenaDamageRecoveryPath(record()), 'none')
    recordArenaDamageElement(f.c, f.event('921', 14004, { op: 7 }))
    recordArenaDamageElement(f.c, f.event('922', 14004, { op: 10 }))
    assert.equal(arenaDamageRecoveryPath(f.c.state.combat.npcDuel.damage_elements['921']), 'none')
    assert.equal(arenaDamageRecoveryPath(f.c.state.combat.npcDuel.damage_elements['922']), 'unresolved')
    assert.equal(arenaDamageRecoveryPath({}), 'unresolved')
})

test('transient history preserves active DOTs and keeps recently-ended low-valued IDs for delayed records', () => {
    const f = context(),
        uid = '900'
    assert.equal(arenaDamageElement(14004).isLasting, false, 'native DOT.Parse overrides this serialized field')
    recordArenaDamageElement(f.c, f.event(uid, 14004))
    for (let i = 0; i < 520; i++) recordArenaDamageElement(f.c, f.event(String(10000 + i), 503001101))
    assert.equal(Object.keys(f.c.state.combat.npcDuel.damage_elements).length, 513)
    assert.ok(arenaDamageRecord(f.c, { tar_id: f.enemy.uuid, element_uniqueId: uid }))
    recordArenaDamageElement(f.c, { op: 2, uniqueId: uid, tar_id: f.enemy.uuid })
    assert.equal(Object.keys(f.c.state.combat.npcDuel.damage_elements).length, 512)
    assert.ok(
        arenaDamageRecord(f.c, { tar_id: f.enemy.uuid, element_uniqueId: uid }),
        'recent deletion moves into history by observation order, not numeric key order',
    )
    for (let i = 0; i < 512; i++) recordArenaDamageElement(f.c, f.event(String(20000 + i), 503001101))
    assert.equal(arenaDamageRecord(f.c, { tar_id: f.enemy.uuid, element_uniqueId: uid }), null)
})

test('dummy damage reports preserve real HP and scores, while ordinary reported damage still applies afterward', () => {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, data) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-dummy-hp' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        const run = state().combat.npcDuel,
            active = Object.values(run.actors).filter((actor) => run.in_fight[actor.uuid])
        const self = active.find((actor) => actor.camp === 1),
            enemy = active.find((actor) => actor.camp === 2)
        const hp = state().combat.entities[enemy.uuid].hp,
            scores = structuredClone(run.scores)
        const request = {
            base_time: String(now * 1000),
            uint64_dic: [self.uuid, enemy.uuid, '9007199254740993', '500296101'],
            battle_info: [
                {
                    attr_change: {
                        uuid: enemy.uuid,
                        attrButeInfos: [{ attrId: 5, attr_values: [{ attr_type: 6, value: hp - 5 }] }],
                    },
                },
                {
                    element_info: {
                        op: 1,
                        uniqueId: '3',
                        tar_id: '2',
                        clientTmpID: 100,
                        buff: { cfg_id: 4, attacker_id: '1', source_id: '1' },
                    },
                },
                {
                    hurt_info: {
                        from_id: '1',
                        tar_id: '2',
                        element_uniqueId: '3',
                        element_tempId: 100,
                        dmg_inc_id: 1,
                        hp_change: -(hp + 500),
                        cur_hp: hp,
                    },
                },
            ],
        }
        const before = state(),
            writes = store.db.prepare('SELECT total_changes() AS n').get().n,
            original = game.packet
        game.packet = function (name, ...args) {
            if (name === 'CSProtoObjBattleInfoSync') throw Error('dummy HP packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('BattleInfoReduce', request), /dummy HP packet fault/)
        game.packet = original
        assert.deepEqual(state(), before)
        const packets = call('BattleInfoReduce', request)
        assert.equal(state().combat.entities[enemy.uuid].hp, hp, 'dummy records do not perform even a maximum-HP clamp')
        assert.equal(state().combat.entities[enemy.uuid].alive_state, 0)
        assert.equal(state().combat.npcDuel.dead[enemy.uuid], undefined)
        assert.deepEqual(state().combat.npcDuel.scores, scores)
        assert.equal(
            packets.find((packet) => packet.id === 10009).data.infos.find((row) => row.uuid === enemy.uuid).hp,
            hp,
        )
        assert.equal(
            packets.find((packet) => packet.id === 10706).data.battle_info[0].hurt_info.hp_change,
            -(hp + 500),
            'the damage display record remains intact',
        )
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        call('BattleInfoReduce', {
            base_time: request.base_time,
            uint64_dic: [self.uuid, enemy.uuid, '9007199254740994', '503001101'],
            battle_info: [
                {
                    attr_change: {
                        uuid: enemy.uuid,
                        attrButeInfos: [{ attrId: 5, attr_values: [{ attr_type: 6, value: -100000 }] }],
                    },
                },
                {
                    element_info: {
                        op: 1,
                        uniqueId: '3',
                        tar_id: '2',
                        clientTmpID: 200,
                        buff: { cfg_id: 4, attacker_id: '1', source_id: '1' },
                    },
                },
                {
                    hurt_info: {
                        from_id: '1',
                        tar_id: '2',
                        element_uniqueId: '3',
                        element_tempId: 200,
                        dmg_inc_id: 2,
                        hp_change: -10,
                        cur_hp: hp - 10,
                    },
                },
            ],
        })
        assert.equal(state().combat.entities[enemy.uuid].hp, hp - 10)
    } finally {
        store.close()
    }
})

test('real compressed Add/hit reports collect inputs transactionally without changing damage, SP or flush policy', () => {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-damage-inputs' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        const run = state().combat.npcDuel,
            active = Object.values(run.actors).filter((actor) => run.in_fight[actor.uuid])
        const self = active.find((actor) => actor.camp === 1),
            enemy = active.find((actor) => actor.camp === 2),
            uid = '9007199254740993'
        const hp = state().combat.entities[enemy.uuid].hp,
            sp = state().combat.entities[enemy.uuid].sp
        const request = {
            base_time: String(now * 1000),
            uint64_dic: [self.uuid, enemy.uuid, uid, '503001101', '5030012'],
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        uniqueId: '3',
                        tar_id: '2',
                        clientTmpID: 100,
                        buff: { cfg_id: 4, attacker_id: '1', source_id: '1', damage_cri_pct: 0 },
                    },
                },
                {
                    hurt_info: {
                        from_id: '1',
                        tar_id: '2',
                        element_uniqueId: '3',
                        element_tempId: 100,
                        skill_id: 5,
                        hp_change: -10,
                    },
                },
            ],
        }
        const before = state(),
            writes = store.db.prepare('SELECT total_changes() AS n').get().n,
            original = game.packet
        game.packet = function (name, ...args) {
            if (name === 'CSProtoObjBattleInfoSync') throw Error('damage input packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('BattleInfoReduce', request), /damage input packet fault/)
        game.packet = original
        assert.deepEqual(state(), before)
        call('BattleInfoReduce', request)
        const input = arenaDamageInput(
            { tables, state: state() },
            { tar_id: enemy.uuid, element_uniqueId: uid, element_tempId: 100, skill_id: 5030012 },
        )
        assert.equal(input.status, 'ready')
        assert.equal(input.parameter(0), 2000)
        assert.equal(state().combat.entities[enemy.uuid].hp, hp - 10)
        assert.equal(state().combat.entities[enemy.uuid].sp, sp, 'input capture alone does not invent hit SP')
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
    } finally {
        store.close()
    }
})

test('execution readers distinguish before/current state from an original native snapshot and capture HP/SP', () => {
    const f = context(),
        id = f.self.uuid
    const set = (value) =>
        mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value }] }] })
    set(100)
    f.c.state.combat.entities[id] = { ...f.c.state.combat.entities[id], hp: 111, sp: 12 }
    recordArenaDamageElement(f.c, f.event('800', 18009046))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '800', skill_id: 5030012 })
    set(200)
    f.c.state.combat.entities[id] = { ...f.c.state.combat.entities[id], hp: 77, sp: 47 }
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 1, false), 100)
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false, 'snapshot-aware', 'after'), 100)
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false, 'live', 'after'), 200)
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false, 'live', 'before'), 100)
    assert.equal(arenaExecutionResource(f.c, input, 'attacker', 'hp'), 111)
    assert.equal(arenaExecutionResource(f.c, input, 'source', 'sp'), 12)
    assert.equal(arenaExecutionResource(f.c, input, 'source', 'hp', 'live', 'after'), 77)
    assert.equal(arenaExecutionResource(f.c, input, 'source', 'sp', 'live', 'after'), 47)
    assert.throws(
        () => arenaExecutionProperty(f.c, input, 'source', 1, false, 'snapshot-aware', 'before', null, 99),
        /Unknown arena property component/,
    )
})

test('unsnapshotted inputs use their execution capture before a trigger and current properties only when explicitly requested', () => {
    const f = context(),
        id = f.self.uuid
    const other = Object.values(f.c.state.combat.npcDuel.actors).find(
        (actor) => actor.uuid !== id && actor.uuid !== f.enemy.uuid,
    )
    const set = (uuid, value) =>
        mergeArenaProperties(f.c, { uuid, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value }] }] })
    set(id, 10)
    set(other.uuid, 20)
    set(f.enemy.uuid, 30)
    const event = f.event('801')
    event.buff.source_id = other.uuid
    recordArenaDamageElement(f.c, event)
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '801', skill_id: 5030012 })
    set(id, 100)
    set(other.uuid, 200)
    set(f.enemy.uuid, 300)
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 1, false), 10)
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false), 20)
    assert.equal(arenaExecutionProperty(f.c, input, 'target', 1, false), 30)
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 1, false, 'snapshot-aware', 'after'), 100)
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false, 'snapshot-aware', 'after'), 200)
    assert.equal(arenaExecutionProperty(f.c, input, 'target', 1, false, 'snapshot-aware', 'after'), 300)
})

test('native snapshot MAXHP keeps its fractional property value while a frozen live read retains the live integer cast', () => {
    const f = context(),
        id = f.self.uuid
    mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 5, attr_values: [{ attr_type: 6, value: 9.5 }] }] })
    recordArenaDamageElement(f.c, f.event('802', 18009046))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '802', skill_id: 5030012 })
    assert.equal(arenaProperty(f.c, id, 5, undefined, false), 9)
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 5, false, 'live', 'before'), 9)
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 5, false), 9.5)
})

test('execution property readers reject unresolved inheritance, missing capture/roles and stale entity generations', () => {
    const f = context()
    recordArenaDamageElement(f.c, f.event('803', 18009046, { parentUniqueId: '800' }))
    const unresolved = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '803', skill_id: 5030012 })
    assert.throws(() => arenaExecutionProperty(f.c, unresolved, 'source', 1), /input is unresolved/)
    recordArenaDamageElement(f.c, f.event('804', 18009046))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '804', skill_id: 5030012 })
    assert.throws(() => arenaExecutionProperty(f.c, input, 'owner', 1), /role unavailable/)
    assert.throws(() => arenaExecutionProperty(f.c, input, 'source', 1, true, 'current'), /mode unavailable/)
    assert.throws(
        () => arenaExecutionProperty(f.c, input, 'source', 1, true, 'live', 'before-critical'),
        /phase unavailable/,
    )
    delete input.record.snapshots[f.self.uuid].sp
    assert.throws(() => arenaExecutionResource(f.c, input, 'source', 'sp'), /resource capture unavailable/)
    resetArenaOrigins(f.c)
    assert.throws(() => arenaExecutionProperty(f.c, input, 'source', 1), /input is stale/)
})

test('known-UID combine/rebuild reports cannot reuse an initial-execution phase or invent an original snapshot', () => {
    const f = context(),
        lookup = (uid) => arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: uid, skill_id: 5030012 })
    const event = f.event('805', 18009046)
    recordArenaDamageElement(f.c, event)
    const original = lookup('805')
    const captured = arenaExecutionProperty(f.c, original, 'attacker', 1)
    recordArenaDamageElement(f.c, { ...event, op: 7 })
    const combined = lookup('805')
    assert.equal(combined.recovery_path, 'none')
    assert.equal(combined.record.execution_kind, 'combine')
    assert.equal(combined.record.before_execution, undefined)
    assert.equal(arenaExecutionProperty(f.c, combined, 'attacker', 1), captured)
    assert.throws(
        () => arenaExecutionProperty(f.c, combined, 'attacker', 1, true, 'live', 'before'),
        /capture unavailable/,
    )
    assert.throws(() => arenaExecutionProperty(f.c, original, 'attacker', 1), /input is stale/)
    recordArenaDamageElement(f.c, { ...event, op: 10 })
    assert.equal(lookup('805').recovery_path, 'unresolved')
    assert.equal(lookup('805').record.execution_kind, 'rebuild')
    recordArenaDamageElement(f.c, f.event('806', 18009046, { op: 10 }))
    assert.throws(() => arenaExecutionProperty(f.c, lookup('806'), 'attacker', 1), /original snapshot was not observed/)
    recordArenaDamageElement(f.c, f.event('807', 18009046, { op: 7 }))
    assert.throws(
        () => arenaExecutionResource(f.c, lookup('807'), 'attacker', 'sp'),
        /original snapshot was not observed/,
    )
})

test('observed Weather parent/source6/configured child uses its own native snapshot despite a parent UID', () => {
    const f = context(),
        id = f.self.uuid
    recordArenaElementOrigin(f.c, {
        op: 1,
        uniqueId: '9001',
        tar_id: f.enemy.uuid,
        buff: { cfg_id: 500007079, source_id: id },
        verify_info: { battle_index: '4294967400' },
    })
    mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value: 123 }] }] })
    recordArenaDamageElement(
        f.c,
        f.event('9002', 500007078, {
            parentUniqueId: '9001',
            verify_info: { source_type: 6, battle_index: '4294967401' },
        }),
    )
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '9002' })
    assert.equal(input.status, 'ready')
    assert.equal(input.record.parent, '9001')
    assert.equal(input.record.snapshot_mode, 'own')
    assert.equal(input.record.snapshot_policy_evidence.parent_config, 500007079)
    assert.equal(input.record.snapshot_policy_evidence.source_type, 6)
    const execution = arenaElementExecutionInput(f.c, '9002')
    assert.equal(execution.status, 'ready')
    assert.equal(execution.skill, 0, 'the native Weather Parse call supplies0 explicitly')
    assert.equal(execution.skill_source, 'weather-injection')
    mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value: 456 }] }] })
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 1, false), 123)
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 1, false, 'live', 'after'), 456)
})

test('parent type or a listed injection alone cannot establish the Weather independent-snapshot path', () => {
    const f = context(),
        event = (uid, config = 500007078, type = 6) =>
            f.event(uid, config, {
                parentUniqueId: '9010',
                verify_info: { source_type: type, battle_index: String(Number(uid) + 100000) },
            })
    const lookup = (uid) => arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: uid })
    recordArenaDamageElement(f.c, event('9011'))
    assert.equal(lookup('9011').status, 'inherited-snapshot-unresolved', 'unobserved parent is not presumed present')
    const parent = {
        op: 1,
        uniqueId: '9010',
        buff: { cfg_id: 500007079, source_id: f.self.uuid },
        verify_info: { battle_index: '4294967410' },
    }
    recordArenaElementOrigin(f.c, parent)
    recordArenaDamageElement(f.c, event('9012', 500007078, 2))
    assert.equal(lookup('9012').status, 'inherited-snapshot-unresolved')
    recordArenaDamageElement(f.c, event('9013', 503001101))
    assert.equal(lookup('9013').status, 'inherited-snapshot-unresolved', 'not listed in actual Weather injection lists')
    const declared = event('9015')
    declared.buff.source_behavior_id = ((1n << 32n) | 5030012n).toString()
    recordArenaDamageElement(f.c, declared)
    assert.equal(
        lookup('9015').status,
        'inherited-snapshot-unresolved',
        'a declared skill contradicts the Weather call',
    )
    recordArenaElementOrigin(f.c, { ...parent, buff: { ...parent.buff, cfg_id: 30900802 } })
    recordArenaDamageElement(f.c, event('9014'))
    assert.equal(lookup('9014').status, 'inherited-snapshot-unresolved', 'conflicting parent identity stays unresolved')
})

test('observed Buff injection overrides a snapshot-enabled child with the proven non-snapshot parent state', () => {
    const f = context(),
        id = f.self.uuid
    recordArenaSkillOrigin(f.c, { unit_id: id, skill: { skill_id: 5030012 }, verify_info: { battle_index: '7000' } })
    const parent = f.event('7001', 112002119, {
        verify_info: { battle_index: '7002', related_index: '7000', source_type: 1 },
    })
    recordArenaElementOrigin(f.c, parent)
    assert.equal(f.c.state.combat.npcDuel.origin_nodes['7002'].snapshot_state.mode, 'none')
    mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value: 111 }] }] })
    const child = f.event('7003', 112002099, {
        parentUniqueId: '7001',
        verify_info: { battle_index: '7004', related_index: '7002', source_type: 2 },
    })
    recordArenaElementOrigin(f.c, child)
    recordArenaDamageElement(f.c, child)
    const input = arenaElementExecutionInput(f.c, '7003')
    assert.equal(input.config.snapshot, true, 'the child asset really enables snapshot')
    assert.equal(input.status, 'ready')
    assert.equal(input.record.snapshot_mode, 'none', 'Buff overrides it after child Parse')
    assert.equal(input.record.snapshot_policy_evidence.via, 'buff-after-parse')
    assert.equal(input.record.snapshots, undefined)
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 1, false), 111)
    mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value: 222 }] }] })
    assert.equal(arenaExecutionProperty(f.c, input, 'attacker', 1, false, 'snapshot-aware', 'after'), 222)
})

test('notDel children can prove Buff inheritance through the verify parent even without a parent UID', () => {
    const f = context()
    recordArenaSkillOrigin(f.c, {
        unit_id: f.self.uuid,
        skill: { skill_id: 5030012 },
        verify_info: { battle_index: '7100' },
    })
    recordArenaElementOrigin(
        f.c,
        f.event('7101', 199, { verify_info: { battle_index: '7102', related_index: '7100', source_type: 1 } }),
    )
    const child = f.event('7103', 196, { verify_info: { battle_index: '7104', related_index: '7102', source_type: 2 } })
    recordArenaElementOrigin(f.c, child)
    recordArenaDamageElement(f.c, child)
    const input = arenaElementExecutionInput(f.c, '7103')
    assert.equal(input.status, 'ready')
    assert.equal(input.record.parent, '0')
    assert.equal(input.record.snapshot_mode, 'none')
    assert.equal(input.record.snapshot_policy_evidence.paths[0], 'notDelElementDataList[0]')
    recordArenaDamageElement(f.c, { ...child, uniqueId: '7105', parentUniqueId: '7101' })
    assert.equal(
        arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '7105' }).status,
        'inherited-snapshot-unresolved',
        'the wrong parent-UID shape does not match that native branch',
    )
})

test('a verify Element parent without a UID is unresolved when no observed injection establishes its snapshot policy', () => {
    const f = context()
    recordArenaDamageElement(f.c, f.event('7201', 18009046, { verify_info: { source_type: 2, related_index: '7200' } }))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '7201' })
    assert.equal(input.status, 'inherited-snapshot-unresolved')
    assert.equal(input.record.snapshots, undefined, 'missing UID must not create a fresh independent snapshot')
    recordArenaElementOrigin(f.c, f.event('7202', 112002119, { verify_info: { battle_index: '7203' } }))
    assert.equal(
        f.c.state.combat.npcDuel.origin_nodes['7203'].snapshot_state,
        undefined,
        'a configured flag alone does not prove the effective parent state',
    )
    recordArenaDamageElement(
        f.c,
        f.event('7204', 112002099, { parentUniqueId: '7202', verify_info: { source_type: 2, related_index: '7203' } }),
    )
    assert.equal(
        arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '7204' }).status,
        'inherited-snapshot-unresolved',
    )
})

test('Buff snapshot evidence does not flow blindly through Trigger parents or mismatched/declared skill sources', () => {
    const f = context()
    recordArenaSkillOrigin(f.c, {
        unit_id: f.self.uuid,
        skill: { skill_id: 5030012 },
        verify_info: { battle_index: '7300' },
    })
    recordArenaElementOrigin(
        f.c,
        f.event('7301', 30900802, { verify_info: { battle_index: '7302', related_index: '7300', source_type: 1 } }),
    )
    recordArenaElementOrigin(
        f.c,
        f.event('7303', 30900804, {
            parentUniqueId: '7301',
            verify_info: { battle_index: '7304', related_index: '7302', source_type: 2 },
        }),
    )
    assert.equal(f.c.state.combat.npcDuel.origin_nodes['7304'].snapshot_state.mode, 'none')
    assert.equal(f.c.state.combat.npcDuel.origin_nodes['7304'].element_type, 'ConfigTTriggerElementParams')
    recordArenaDamageElement(
        f.c,
        f.event('7305', 18009046, { parentUniqueId: '7303', verify_info: { source_type: 2, related_index: '7304' } }),
    )
    assert.equal(
        arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '7305' }).status,
        'inherited-snapshot-unresolved',
    )
    const parent = f.event('7306', 112002119, {
        verify_info: { battle_index: '7307', related_index: '7300', source_type: 1 },
    })
    recordArenaElementOrigin(f.c, parent)
    const child = f.event('7308', 112002099, {
        parentUniqueId: '999999',
        verify_info: { source_type: 2, related_index: '7307' },
    })
    recordArenaDamageElement(f.c, child)
    assert.equal(
        arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '7308' }).status,
        'inherited-snapshot-unresolved',
    )
    child.uniqueId = '7309'
    child.parentUniqueId = '7306'
    child.buff.source_behavior_id = ((1n << 32n) | 5030012n).toString()
    recordArenaDamageElement(f.c, child)
    assert.equal(
        arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '7309' }).status,
        'inherited-snapshot-unresolved',
    )
})

test('observed own snapshots register once and release manager keys without erasing historical execution inputs', () => {
    const f = context(),
        id = f.self.uuid
    const event = f.event('8100', 18009046, { verify_info: { source_type: 1, battle_index: '8101' } })
    recordArenaDamageElement(f.c, event)
    const lookup = () => arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '8100', skill_id: 5030012 })
    const original = arenaExecutionProperty(f.c, lookup(), 'attacker', 1)
    const view = arenaSnapshotView(f.c, '8100')
    assert.equal(view.status, 'known')
    assert.equal(lookup().record.snapshot_key, '8100')
    mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value: 999 }] }] })
    recordArenaDamageElement(f.c, event)
    assert.deepEqual(arenaSnapshotView(f.c, '8100'), view, 'retry does not replace the manager entry')
    recordArenaDamageElement(f.c, { op: 2, uniqueId: '8100', tar_id: f.enemy.uuid })
    assert.equal(arenaSnapshotView(f.c, '8100').ended, true)
    assert.deepEqual(arenaSnapshotView(f.c, '8100').captures, {})
    assert.equal(
        arenaExecutionProperty(f.c, lookup(), 'attacker', 1),
        original,
        'late HurtInfo still reads its past execution',
    )
    recordArenaDamageElement(f.c, event)
    assert.equal(arenaSnapshotView(f.c, '8100').ended, true)
    assert.equal(lookup().record.ended, true)
    // A legacy retained execution can have no manager metadata at all. Its
    // late Add retry must not manufacture a live key after the release.
    delete lookup().record.snapshot_registry
    delete f.c.state.combat.npcDuel.snapshot_owners
    delete f.c.state.combat.npcDuel.arena_snapshots
    recordArenaDamageElement(f.c, event)
    assert.equal(arenaSnapshotView(f.c, '8100').status, 'unobserved')
    assert.equal(arenaExecutionProperty(f.c, lookup(), 'attacker', 1), original)
})

test('future DOT execution sees an observed shared-key deletion while prior execution history stays frozen', () => {
    const f = context(),
        id = f.self.uuid
    const dot = Number(
        Object.keys(catalog.elements).find(
            (key) => catalog.elements[key].config.kind === 'dot' && catalog.elements[key].config.snapshot,
        ),
    )
    recordArenaDamageElement(f.c, f.event('8200', dot, { verify_info: { source_type: 1, battle_index: '8201' } }))
    const lookup = () => arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '8200', skill_id: 5030012 })
    assert.equal(lookup().record.snapshot_registry, true)
    const before = arenaExecutionProperty(f.c, lookup(), 'attacker', 1)
    assert.ok(before > 0)
    // Exercise the native manager primitive, not an unimplemented automatic
    // parent-injection resolver: this explicit consumer shares only one entity.
    bindArenaSnapshot(f.c, '8202', '8200', [id])
    releaseArenaSnapshot(f.c, '8202')
    assert.equal(
        arenaExecutionProperty(f.c, lookup(), 'attacker', 1),
        before,
        'a completed execution retains its input',
    )
    recordArenaDamageElement(f.c, { op: 8, uniqueId: '8200', tar_id: f.enemy.uuid })
    assert.equal(arenaExecutionProperty(f.c, lookup(), 'attacker', 1), 0, 'next tick observes the proven missing key')
    assert.equal(arenaExecutionResource(f.c, lookup(), 'attacker', 'sp'), 0)
    assert.ok(
        arenaExecutionProperty(f.c, lookup(), 'target', 5) > 0,
        'a different entity sharing the key was not removed',
    )
    assert.ok(arenaExecutionProperty(f.c, lookup(), 'attacker', 1, true, 'live', 'before') > 0)
})

test('snapshot release survives damage-input eviction and an old Add cannot recreate the lost original input', () => {
    const f = context(),
        event = f.event('8300', 18009046, { verify_info: { source_type: 1, battle_index: '8301' } })
    recordArenaDamageElement(f.c, event)
    for (let i = 0; i < 514; i++) recordArenaDamageElement(f.c, f.event(String(8400 + i)))
    assert.equal(f.c.state.combat.npcDuel.damage_elements['8300'], undefined)
    recordArenaDamageElement(f.c, { op: 2, uniqueId: '8300', tar_id: f.enemy.uuid })
    assert.equal(arenaSnapshotView(f.c, '8300').ended, true)
    recordArenaDamageElement(f.c, event)
    const replay = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '8300', skill_id: 5030012 })
    assert.equal(replay.recovery_path, 'unresolved')
    assert.equal(replay.record.snapshot_observed, false)
    assert.equal(replay.record.before_execution, undefined)
    assert.throws(() => arenaExecutionProperty(f.c, replay, 'attacker', 1), /original snapshot was not observed/)
})

test('all actual non-snapshot Trigger to snapshot DOT paths inherit the proven empty key instead of taking a new snapshot', () => {
    const metadata = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-elements.json', import.meta.url), 'utf8'))
    const pairs = Object.entries(metadata.elements).flatMap(([id, row]) =>
        row.config.type === 'ConfigTTriggerElementParams' && !row.config.snapshot
            ? row.config.injections
                  .filter((edge) => edge.status === 'resolved' && catalog.elements[edge.config_id]?.config.snapshot)
                  .map((edge) => [Number(id), edge.config_id])
            : [],
    )
    assert.equal(pairs.length, 6)
    for (const [parentConfig, childConfig] of pairs) {
        const f = context()
        recordArenaSkillOrigin(f.c, {
            unit_id: f.self.uuid,
            skill: { skill_id: 5030012 },
            verify_info: { battle_index: '9100' },
        })
        recordArenaElementOrigin(
            f.c,
            f.event('9101', parentConfig, {
                verify_info: { battle_index: '9102', source_type: 1, related_index: '9100' },
            }),
        )
        assert.equal(f.c.state.combat.npcDuel.origin_nodes['9102'].snapshot_state.key, '0')
        const child = f.event('9103', childConfig, {
            parentUniqueId: '9101',
            verify_info: { battle_index: '9104', source_type: 2, related_index: '9102' },
        })
        recordArenaElementOrigin(f.c, child)
        recordArenaDamageElement(f.c, child)
        const lookup = () => arenaElementExecutionInput(f.c, '9103')
        assert.equal(lookup().status, 'ready')
        assert.equal(lookup().record.snapshot_mode, 'inherited')
        assert.equal(lookup().record.snapshot_key, '0')
        assert.equal(arenaExecutionProperty(f.c, lookup(), 'source', 1), 0)
        assert.equal(arenaExecutionResource(f.c, lookup(), 'target', 'hp'), 0)
        assert.ok(arenaExecutionProperty(f.c, lookup(), 'source', 1, true, 'live', 'before') > 0)
        assert.equal(f.c.state.combat.npcDuel.arena_snapshots?.['0'], undefined)
        recordArenaDamageElement(f.c, { op: 8, uniqueId: '9103', tar_id: f.enemy.uuid })
        assert.equal(arenaExecutionProperty(f.c, lookup(), 'source', 1), 0)
        recordArenaDamageElement(f.c, { op: 2, uniqueId: '9103', tar_id: f.enemy.uuid })
        assert.equal(arenaSnapshotView(f.c, '9103').ended, true)
        assert.equal(arenaExecutionProperty(f.c, lookup(), 'source', 1), 0)
    }
})

test('Trigger inheritance cannot infer an empty key from a missing parent, an old flag-only record or mismatched observed UID', () => {
    const f = context()
    const child = (uid) =>
        f.event(uid, 14002, { parentUniqueId: '9201', verify_info: { source_type: 2, related_index: '9202' } })
    const lookup = (uid) => arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: uid })
    recordArenaDamageElement(f.c, child('9203'))
    assert.equal(lookup('9203').status, 'inherited-snapshot-unresolved')
    recordArenaSkillOrigin(f.c, {
        unit_id: f.self.uuid,
        skill: { skill_id: 5030012 },
        verify_info: { battle_index: '9200' },
    })
    recordArenaElementOrigin(
        f.c,
        f.event('9201', 510110201, { verify_info: { battle_index: '9202', source_type: 1, related_index: '9200' } }),
    )
    delete f.c.state.combat.npcDuel.origin_nodes['9202'].snapshot_state.key
    recordArenaDamageElement(f.c, child('9204'))
    assert.equal(lookup('9204').status, 'inherited-snapshot-unresolved')
    assert.equal(arenaSnapshotView(f.c, '9204').status, 'unobserved')
    f.c.state.combat.npcDuel.origin_nodes['9202'].snapshot_state.key = '0'
    recordArenaDamageElement(f.c, { ...child('9205'), parentUniqueId: '99999' })
    assert.equal(lookup('9205').status, 'inherited-snapshot-unresolved')
})

test('Trigger child configuration can disable inherited snapshot reads while retaining the inherited key evidence', () => {
    const metadata = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-elements.json', import.meta.url), 'utf8'))
    const pair = Object.entries(metadata.elements).flatMap(([id, row]) =>
        row.config.type === 'ConfigTTriggerElementParams' && !row.config.snapshot
            ? row.config.injections
                  .filter(
                      (edge) =>
                          edge.status === 'resolved' &&
                          catalog.elements[edge.config_id] &&
                          !catalog.elements[edge.config_id].config.snapshot,
                  )
                  .map((edge) => [Number(id), edge.config_id])
            : [],
    )[0]
    assert.ok(pair)
    const f = context()
    recordArenaSkillOrigin(f.c, {
        unit_id: f.self.uuid,
        skill: { skill_id: 5030012 },
        verify_info: { battle_index: '9300' },
    })
    recordArenaElementOrigin(
        f.c,
        f.event('9301', pair[0], { verify_info: { battle_index: '9302', source_type: 1, related_index: '9300' } }),
    )
    const child = f.event('9303', pair[1], {
        parentUniqueId: '9301',
        verify_info: { battle_index: '9304', source_type: 2, related_index: '9302' },
    })
    recordArenaElementOrigin(f.c, child)
    recordArenaDamageElement(f.c, child)
    const input = arenaElementExecutionInput(f.c, '9303')
    assert.equal(input.status, 'ready')
    assert.equal(input.record.snapshot_mode, 'none')
    assert.equal(f.c.state.combat.npcDuel.origin_nodes['9304'].snapshot_state.key, '0')
    assert.ok(arenaExecutionProperty(f.c, input, 'source', 1) > 0)
    assert.equal(arenaSnapshotView(f.c, '9303').status, 'unobserved')
})

test('actual formula101 binds attacker/target/source separately and uses recorded parameters plus the requested execution phase', () => {
    const f = context(),
        other = Object.values(f.c.state.combat.npcDuel.actors).find(
            (actor) => actor.uuid !== f.self.uuid && actor.uuid !== f.enemy.uuid,
        )
    const force = (uuid, value) =>
        mergeArenaProperties(f.c, { uuid, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 6, value }] }] })
    force(f.self.uuid, 100)
    force(f.enemy.uuid, 300)
    force(other.uuid, 600)
    const event = f.event('9400')
    event.buff.source_id = other.uuid
    event.buff.source_behavior_id = ((1n << 32n) | 5030012n).toString()
    recordArenaDamageElement(f.c, event)
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '9400', skill_id: 5030012 })
    const item = (target) => ({ target, operation: 1, custom_int: 0, prefix: 1 })
    assert.equal(arenaFormulaEntity(f.c, input, item(1)), 100)
    assert.equal(arenaFormulaEntity(f.c, input, item(2)), 300)
    assert.equal(arenaFormulaEntity(f.c, input, item(3)), 600)
    assert.equal(input.parameter(0), 2000)
    assert.equal(arenaExecutionFormula(f.c, input), 20)
    assert.deepEqual(input.record.formula_trace, {
        status: 'calculated',
        formula_id: 101,
        value: 20,
        phase: 'before',
        basis: 'accepted-server-state',
    })
    force(f.self.uuid, 250)
    assert.equal(arenaExecutionFormula(f.c, input), 20)
    assert.equal(arenaExecutionFormula(f.c, input, { phase: 'after' }), 50)
})

test('native snapshot property components retain base/dynamic values and the untouched external-percent field stays zero', () => {
    const f = context(),
        id = f.self.uuid
    f.self.base_properties[1] = { base: 100, extra: 10, percent: 0.25 }
    mergeArenaProperties(f.c, {
        uuid: id,
        attrButeInfos: [
            {
                attrId: 1,
                attr_values: [
                    { attr_type: 3, value: 5 },
                    { attr_type: 4, value: 7 },
                    { attr_type: 5, value: 0.5 },
                    { attr_type: 6, value: 999 },
                ],
            },
        ],
    })
    recordArenaDamageElement(f.c, f.event('9401', 18009046))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '9401', skill_id: 5030012 })
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false), 999)
    assert.deepEqual(
        [1, 2, 3, 4, 5, 6].map((component) =>
            arenaExecutionProperty(f.c, input, 'source', 1, false, 'snapshot-aware', 'before', null, component),
        ),
        [100, 10, 0, 135, 7, 0.5],
    )
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false, 'live', 'before', null, 3), 0.25)
    const component = (custom_int) => ({ target: 1, operation: 1, custom_int, prefix: 1 })
    assert.equal(arenaFormulaEntity(f.c, input, component(4)), 135)
    assert.equal(arenaFormulaEntity(f.c, input, component(-5)), 0, 'native default selector branch is zero')
    mergeArenaProperties(f.c, { uuid: id, attrButeInfos: [{ attrId: 1, attr_values: [{ attr_type: 4, value: 37 }] }] })
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false, 'snapshot-aware', 'after', null, 5), 7)
    assert.equal(arenaExecutionProperty(f.c, input, 'source', 1, false, 'live', 'after', null, 5), 37)
})

test('formula HP/SP respect snapshot selection while the recorded native life state controls death-key redirection', () => {
    const f = context(),
        id = f.self.uuid
    f.c.state.combat.entities[id] = { ...f.c.state.combat.entities[id], hp: 123, sp: 17 }
    recordArenaDamageElement(f.c, f.event('9402', 18009046))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '9402', skill_id: 5030012 })
    const item = (operation) => ({ target: 1, operation, custom_int: 0, prefix: 1 })
    f.c.state.combat.entities[id] = { ...f.c.state.combat.entities[id], hp: 5, sp: 2, alive_state: 1 }
    assert.equal(arenaFormulaEntity(f.c, input, item(-2)), 123)
    assert.equal(arenaFormulaEntity(f.c, input, item(-3)), 17)
    for (const alive_state of [1, 2, 3]) {
        f.c.state.combat.entities[id].alive_state = alive_state
        assert.throws(() => arenaFormulaEntity(f.c, input, item(-2), { phase: 'after' }), /death snapshot unavailable/)
    }
    f.c.state.combat.entities[id].alive_state = 4
    assert.equal(arenaFormulaEntity(f.c, input, item(-2), { phase: 'after' }), 123, 'native isDead excludes4')
    delete input.record.before_execution[id].alive_state
    assert.throws(() => arenaFormulaEntity(f.c, input, item(-2)), /life state unavailable/)
})

test('formula dependencies for shield, source-player and unsupported special state are explicit rather than guessed zero', () => {
    const f = context()
    recordArenaDamageElement(f.c, f.event('9403'))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '9403', skill_id: 5030012 })
    const item = (operation, target = 1) => ({ target, operation, custom_int: 0, prefix: 1 })
    assert.throws(() => arenaFormulaEntity(f.c, input, item(111)), /shield state unavailable/)
    assert.throws(() => arenaFormulaEntity(f.c, input, item(1, 4)), /source-player unavailable/)
    assert.throws(() => arenaFormulaEntity(f.c, input, item(-1)), /special formula input unavailable/)
    assert.equal(arenaFormulaEntity(f.c, input, item(-19)), 0)
    assert.equal(
        arenaFormulaEntity(f.c, input, item(-1), {
            special: ({ role, uuid }) => {
                assert.equal(role, 'attacker')
                assert.equal(uuid, f.self.uuid)
                return 4
            },
        }),
        4,
    )
    assert.throws(
        () => arenaFormulaEntity(f.c, input, item(-1), { special: () => NaN }),
        /special formula input unavailable/,
    )
    for (const op of [-4, -5, -10]) assert.equal(arenaFormulaEntity(f.c, input, item(op)), 0)
})

test('prepared formula contexts validate even parameter-only callbacks across entity rebuilds and preserve explicit external services', () => {
    const f = context()
    recordArenaDamageElement(f.c, f.event('9404'))
    const input = arenaDamageInput(f.c, { tar_id: f.enemy.uuid, element_uniqueId: '9404', skill_id: 5030012 })
    const formulaContext = arenaExecutionFormulaContext(f.c, input, { worldLevel: () => 8 })
    assert.equal(evaluateArenaFormula(5, formulaContext), 2000)
    assert.equal(formulaContext.worldLevel(), 8)
    assert.equal(formulaContext.random, undefined)
    resetArenaOrigins(f.c)
    assert.throws(() => evaluateArenaFormula(5, formulaContext), /input is stale/)
    assert.throws(() => formulaContext.worldLevel(), /input is stale/)
    assert.throws(() => arenaExecutionFormula(f.c, input), /input is stale/)
})

test('formula bindings retain known inherited empty-key values without overriding the native death-snapshot rule', () => {
    const f = context()
    recordArenaSkillOrigin(f.c, {
        unit_id: f.self.uuid,
        skill: { skill_id: 5030012 },
        verify_info: { battle_index: '9500' },
    })
    recordArenaElementOrigin(
        f.c,
        f.event('9501', 510110201, { verify_info: { battle_index: '9502', source_type: 1, related_index: '9500' } }),
    )
    const child = f.event('9503', 14002, {
        parentUniqueId: '9501',
        verify_info: { battle_index: '9504', source_type: 2, related_index: '9502' },
    })
    recordArenaElementOrigin(f.c, child)
    recordArenaDamageElement(f.c, child)
    const input = arenaElementExecutionInput(f.c, '9503'),
        formulaContext = arenaExecutionFormulaContext(f.c, input)
    assert.equal(evaluateArenaFormula(101, formulaContext), 0)
    assert.equal(arenaFormulaEntity(f.c, input, { target: 1, operation: 1, custom_int: 4, prefix: 1 }), 0)
    f.c.state.combat.entities[f.self.uuid].alive_state = 1
    assert.throws(
        () => arenaFormulaEntity(f.c, input, { target: 1, operation: 1, custom_int: 0, prefix: 1 }, { phase: 'after' }),
        /death snapshot unavailable/,
    )
})

test('death-snapshot diagnostic warns once across configurations while preserving each unresolved trace', () => {
    const f = context(),
        configs = Object.keys(catalog.elements)
            .map(Number)
            .filter((id) => {
                const config = catalog.elements[id].config
                return config.kind === 'damage' && config.formula_id === 101
            })
            .slice(0, 3),
        messages = [],
        original = console.warn
    assert.equal(configs.length, 3)
    f.c.state.combat.entities[f.self.uuid].alive_state = 1
    const before = structuredClone(f.c.state.combat.entities)
    console.warn = (message) => messages.push(message)
    try {
        recordArenaSkillOrigin(f.c, {
            unit_id: f.self.uuid,
            skill: { skill_id: 5030012 },
            verify_info: { battle_index: '9699' },
        })
        for (let i = 0; i < configs.length; i++) {
            const id = String(9700 + i)
            const event = f.event(id, configs[i], {
                verify_info: {
                    battle_index: String(9800 + i),
                    source_type: 1,
                    related_index: '9699',
                },
            })
            recordArenaElementOrigin(f.c, event)
            recordArenaDamageElement(f.c, event)
            const trace = f.c.state.combat.npcDuel.damage_elements[id].formula_trace
            assert.equal(trace.status, 'unresolved')
            assert.match(trace.reason, /death snapshot unavailable/)
        }
        assert.equal(messages.length, 1, 'one missing provider must not emit a warning for every element config')
        assert.match(messages[0], /client damage processing continues/)
        assert.deepEqual(f.c.state.combat.entities, before, 'a formula diagnostic is never authority over HP or SP')
    } finally {
        console.warn = original
    }
})

test('runtime formula attempts retain unresolved dependencies and warn once without granting HP/SP or retaining a stale combine result', () => {
    const f = context()
    // Legacy state without native-owner construction metadata must not infer
    // the numerical grade from its logical owner_id or trainer/master.
    delete f.c.state.combat.npcDuel.actors[f.self.uuid].native_owner
    const configId = Number(
        Object.keys(catalog.elements).find((id) => {
            const row = catalog.elements[id].config
            return (
                row.kind === 'damage' &&
                row.snapshot &&
                row.formula_id === 2 &&
                Number(id) !== 18009046 &&
                [1, 2].includes(row.damageType)
            )
        }),
    )
    assert.ok(configId)
    const resources = Object.fromEntries(Object.entries(f.c.state.combat.entities).map(([id, e]) => [id, [e.hp, e.sp]]))
    const event = (uid) => {
        const e = f.event(uid, configId)
        e.buff.source_behavior_id = ((1n << 32n) | 5030012n).toString()
        return e
    }
    const messages = [],
        original = console.warn
    console.warn = (message) => messages.push(message)
    try {
        recordArenaDamageElement(f.c, event('9600'))
        recordArenaDamageElement(f.c, event('9601'))
        const trace = f.c.state.combat.npcDuel.damage_elements['9600'].formula_trace
        assert.equal(trace.status, 'unresolved')
        assert.equal(trace.formula_id, 2)
        assert.match(trace.reason, /special formula input unavailable/)
        assert.equal(messages.length, 1)
        assert.match(messages[0], /Base formula unresolved/)
        assert.deepEqual(
            Object.fromEntries(Object.entries(f.c.state.combat.entities).map(([id, e]) => [id, [e.hp, e.sp]])),
            resources,
        )
        recordArenaDamageElement(f.c, { ...event('9600'), op: 7 })
        assert.equal(f.c.state.combat.npcDuel.damage_elements['9600'].formula_trace, undefined)
    } finally {
        console.warn = original
    }
})
