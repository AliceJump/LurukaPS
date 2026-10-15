import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPetAttributes, arenaPetSkills } from '../src/kibo-arena-attributes.js'
import { initializeNpcDuelBattle } from '../src/npc-kibo-battle.js'
import { recordArenaDamageElement, arenaElementExecutionInput } from '../src/npc-kibo-damage-inputs.js'
import {
    recordArenaSkillOrigin,
    recordArenaBulletOrigin,
    recordArenaElementOrigin,
    arenaElementOrigin,
    resetArenaOrigins,
    arenaPackedSkillOrigin,
} from '../src/npc-kibo-origins.js'
import { arenaProperty } from '../src/npc-kibo-properties.js'
import { evaluateArenaFormula } from '../src/npc-kibo-formulas.js'
import { arenaHealingAmounts } from '../src/npc-kibo-damage-amounts.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
const catalog = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-damage.json', import.meta.url), 'utf8'))
const heal = Object.entries(catalog.elements).find(
    ([, row]) =>
        row.config.kind === 'damage' &&
        row.config.damageType === 5 &&
        [3, 5].includes(row.config.formula_id) &&
        row.config.parameters[0] > 0,
)
function context() {
    const state = {
        player: { basic_info: { id: 1 } },
        world: { map_id: 1052 },
        multiCampaign: { duel_id: 501, map_id: 1052, start_time: 100, arena_status: 4 },
    }
    const data = arenaPetAttributes(tables, 500020, 5)
    initializeNpcDuelBattle(
        tables,
        state,
        {
            hero_info: { hero_guid: '123' },
            infos: [{ pet_guid: { guid: '456' }, pet_conf_id: 500020, pet_lv: 5, ...data }],
        },
        100,
    )
    const self = Object.values(state.combat.npcDuel.actors).find((row) => row.camp === 1),
        enemy = Object.values(state.combat.npcDuel.actors).find((row) => row.camp === 2)
    const c = { state, tables, now: 100 }
    const skill = (index, id = 5030012, extra = {}) =>
        recordArenaSkillOrigin(c, {
            unit_id: self.uuid,
            skill: { skill_id: id },
            verify_info: { battle_index: index, ...extra },
        })
    const element = (index, parent, type = 1, id = '901', config = 503001101) => {
        const event = {
            op: 1,
            uniqueId: id,
            tar_id: enemy.uuid,
            clientTmpID: 100,
            buff: { cfg_id: config, source_id: self.uuid, attacker_id: self.uuid },
            verify_info: { battle_index: index, related_index: parent, source_type: type, source_id: '7' },
        }
        recordArenaElementOrigin(c, event)
        recordArenaDamageElement(c, event)
        return event
    }
    return { c, self, enemy, skill, element, run: () => c.state.combat.npcDuel }
}

test('a direct behavior source resolves the explicit skill via related index, not source_id, without HurtInfo', () => {
    const f = context(),
        index = '9007199254740993'
    f.skill(index)
    const event = f.element('9007199254740994', index)
    const input = arenaElementExecutionInput(f.c, event.uniqueId)
    assert.equal(input.status, 'ready')
    assert.equal(input.skill, 5030012)
    assert.equal(input.skill_source, 'lineage')
    assert.equal(input.origin.index, index)
    assert.equal(input.parameter(0), 2000)
    assert.equal(f.run().origin_nodes['9007199254740994'].source_id, '7')
})

test('packed source parameters expose skill IDs only for Skill1 and cross-check an available causal root', () => {
    const packed = ((1n << 32n) | 5030012n).toString()
    assert.equal(arenaPackedSkillOrigin(packed).skill_id, 5030012)
    assert.equal(arenaPackedSkillOrigin(((3n << 32n) | 5030012n).toString()).status, 'unsupported-source-param')
    assert.equal(arenaPackedSkillOrigin(((0x87654321n << 32n) | 0x12345678n).toString()).from_type, 0x87654321)
    const f = context(),
        event = {
            op: 1,
            uniqueId: '950',
            tar_id: f.enemy.uuid,
            buff: { cfg_id: 503001101, source_id: f.self.uuid, attacker_id: f.self.uuid, source_behavior_id: packed },
            verify_info: { battle_index: '500', source_type: 6 },
        }
    recordArenaElementOrigin(f.c, event)
    recordArenaDamageElement(f.c, event)
    assert.equal(arenaElementExecutionInput(f.c, '950').skill, 5030012)
    assert.equal(arenaElementExecutionInput(f.c, '950').skill_source, 'source-param')
    const messages = [],
        original = console.warn
    console.warn = (message) => messages.push(message)
    try {
        f.skill('600', 5030013)
        const conflict = {
            ...event,
            uniqueId: '951',
            verify_info: { battle_index: '601', related_index: '600', source_type: 1 },
        }
        recordArenaElementOrigin(f.c, conflict)
        recordArenaDamageElement(f.c, conflict)
        assert.equal(arenaElementExecutionInput(f.c, '951').status, 'skill-origin-unavailable')
        assert.equal(messages.length, 1)
    } finally {
        console.warn = original
    }
})

test('generic non-damage parents and explicit bullet skill data propagate into descendants with typed provenance', () => {
    const f = context()
    f.skill('100')
    const parent = f.element('101', '100', 1, '910', 50300011)
    assert.equal(f.run().damage_elements?.[parent.uniqueId], undefined, 'the generic parent does not need to be damage')
    f.element('102', '101', 2, '911')
    assert.equal(arenaElementExecutionInput(f.c, '911').skill, 5030012)
    recordArenaBulletOrigin(f.c, f.self.uuid, {
        bullet_id: '800',
        config_id: 100,
        skill_id: 5030013,
        verify_info: { battle_index: '103', related_index: '101', source_type: 2 },
    })
    f.element('104', '103', 3, '912')
    assert.equal(
        arenaElementExecutionInput(f.c, '912').skill,
        5030013,
        'the actual BulletInfo skill is explicit even when its creator has another origin',
    )
})

test('delayed parents resolve lazily while missing or mismatched parents and cycles stay explicit', () => {
    const f = context()
    f.element('101', '100')
    assert.equal(arenaElementExecutionInput(f.c, '901').status, 'skill-origin-unavailable')
    f.skill('100')
    assert.equal(arenaElementExecutionInput(f.c, '901').skill, 5030012)
    recordArenaBulletOrigin(f.c, f.self.uuid, {
        bullet_id: '800',
        config_id: 100,
        skill_id: 5030013,
        verify_info: { battle_index: '102' },
    })
    f.element('103', '102', 1, '902')
    assert.equal(arenaElementExecutionInput(f.c, '902').origin.status, 'parent-kind-mismatch')
    f.element('110', '111', 2, '903')
    f.element('111', '110', 2, '904')
    assert.equal(arenaElementExecutionInput(f.c, '903').origin.status, 'cycle')
    f.element('120', '100', 4, '905')
    assert.equal(arenaElementExecutionInput(f.c, '905').origin.status, 'unsupported-source-type')
})

test('duplicate skill acknowledgements do not replace explicit origins, and conflicting indexes do not invent a skill', () => {
    const f = context(),
        messages = [],
        original = console.warn
    console.warn = (message) => messages.push(message)
    try {
        f.skill('100', 5030012, { source_type: 1 })
        f.skill('100', 5030012, { source_type: 5 })
        assert.equal(Object.keys(f.run().origin_nodes).length, 1)
        f.skill('100', 5030013)
        f.skill('100', 5030013)
        f.element('101', '100')
        assert.equal(arenaElementExecutionInput(f.c, '901').origin.status, 'index-conflict')
        assert.equal(messages.length, 1)
    } finally {
        console.warn = original
    }
})

test('bounded origin history does not lose a skill already copied into a long-lived execution receipt', () => {
    const f = context()
    f.skill('100')
    f.element('101', '100')
    const run = f.run()
    for (let i = 0; i < 4094; i++) {
        const index = String(10000 + i)
        run.origin_nodes[index] = { kind: 'skill', index, skill_id: 5030012, actor: f.self.uuid }
        run.origin_order[index] = i + 3
    }
    run.origin_serial = 4096
    f.skill('200000')
    f.skill('200001')
    assert.equal(Object.keys(f.run().origin_nodes).length, 4096)
    assert.equal(f.run().origin_nodes['100'], undefined)
    assert.equal(f.run().origin_nodes['101'], undefined)
    assert.equal(arenaElementExecutionInput(f.c, '901').skill, 5030012)
})

test('new client entities reset only client-local provenance and input receipts while preserving battle values', () => {
    const f = context()
    f.skill('100')
    f.element('101', '100')
    f.run().entities_sent = false
    assert.equal(
        arenaElementExecutionInput(f.c, '901').status,
        'not-in-arena',
        'cached provenance is unavailable while old client entities await rebuilding',
    )
    delete f.run().entities_sent
    const values = structuredClone({
        actors: f.run().actors,
        entities: f.c.state.combat.entities,
        scores: f.run().scores,
    })
    resetArenaOrigins(f.c)
    assert.equal(f.run().origin_epoch, 1)
    assert.deepEqual(f.run().origin_nodes, {})
    assert.deepEqual(f.run().origin_order, {})
    assert.equal(arenaElementExecutionInput(f.c, '901').status, 'element-not-found')
    assert.deepEqual({ actors: f.run().actors, entities: f.c.state.combat.entities, scores: f.run().scores }, values)
    f.skill('100', 5030013)
    f.element('101', '100')
    assert.equal(arenaElementExecutionInput(f.c, '901').skill, 5030013)
})

test('real-schema skill/bullet/Add requests resolve a full-HP heal without a damage callback and roll provenance back on failure', () => {
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
        call('EnterGame', { open_id: 'npc-origin-full-heal' })
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
        const skill = arenaPetSkills(tables, self.config_id).find((skill) => skill.skill_slot === 1)
        call('SkillStart', {
            unit_id: self.uuid,
            skill: { skill_id: skill.skill_id, slot: 1 },
            op_time: String(now * 1000),
            verify_info: { battle_index: '4294967396', source_type: 1 },
        })
        const before = state(),
            writes = store.db.prepare('SELECT total_changes() AS n').get().n
        assert.throws(
            () =>
                call('CreateBullet', {
                    unit_id: self.uuid,
                    bullet_info: [
                        {
                            bullet_id: '800',
                            config_id: 100,
                            skill_id: skill.skill_id,
                            verify_info: { battle_index: '4294967400', related_index: '4294967396', source_type: 1 },
                        },
                        { bullet_id: '801', config_id: 0 },
                    ],
                }),
            /Invalid bullet/,
        )
        assert.deepEqual(state(), before, 'the earlier bullet origin cannot escape a rejected draft')
        call('BattleInfoReduce', {
            base_time: String(now * 1000),
            uint64_dic: [self.uuid, enemy.uuid, '9007199254740993', heal[0], '4294967396'],
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        tar_id: '2',
                        uniqueId: '3',
                        clientTmpID: 100,
                        buff: { cfg_id: 4, source_id: '1', attacker_id: '1', begin_time: '0' },
                        verify_info: {
                            battle_index: '4294967397',
                            related_index: '5',
                            source_type: 1,
                            source_id: '7',
                            op_time: '0',
                        },
                    },
                },
            ],
        })
        const c = { tables, state: state() },
            input = arenaElementExecutionInput(c, '9007199254740993')
        assert.equal(input.status, 'ready')
        assert.equal(input.skill, skill.skill_id)
        assert.equal(input.skill_source, 'lineage')
        const value = arenaHealingAmounts(input.config, {
            formula: evaluateArenaFormula(input.config.formula_id, { parameter: input.parameter }),
            elementTags: input.config.tags,
            sourceProperty: (id, norm) => arenaProperty(c, self.uuid, id, undefined, norm),
            targetProperty: (id, norm) => arenaProperty(c, enemy.uuid, id, undefined, norm),
            targetHp: c.state.combat.entities[enemy.uuid].hp,
            targetMaxHp: arenaProperty(c, enemy.uuid, 5),
        })
        assert.ok(value.outputDamage > 0)
        assert.equal(value.requestedHealAmount, 0)
        assert.equal(c.state.combat.entities[enemy.uuid].hp, before.combat.entities[enemy.uuid].hp)
        assert.equal(
            c.state.combat.entities[enemy.uuid].sp,
            before.combat.entities[enemy.uuid].sp,
            'origin collection does not grant speculative energy',
        )
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const beforeResult = state(),
            original = game.packet
        game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('origin result packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('KiboDuelSurrender'), /origin result packet fault/)
        game.packet = original
        assert.deepEqual(state(), beforeResult, 'terminal packet failure restores the live origin history')
        call('KiboDuelSurrender')
        const finished = state().combat.npcDuel
        assert.equal(finished.origin_nodes, undefined)
        assert.equal(finished.origin_order, undefined)
        assert.equal(finished.damage_elements, undefined)
        assert.equal(finished.origin_epoch, beforeResult.combat.npcDuel.origin_epoch)
        const saved = JSON.parse(store.db.prepare('SELECT state FROM players WHERE account_id=?').get(session.id).state)
        assert.equal(
            saved.combat.npcDuel.origin_nodes,
            undefined,
            'temporary provenance is not written into the result save',
        )
    } finally {
        store.close()
    }
})
