import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createArenaSnapshot,
    bindArenaSnapshot,
    releaseArenaSnapshot,
    arenaSnapshotView,
} from '../src/npc-kibo-snapshots.js'
import { resetArenaOrigins, withoutArenaOrigins } from '../src/npc-kibo-origins.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPetSkills } from '../src/kibo-arena-attributes.js'
import { arenaElementExecutionInput } from '../src/npc-kibo-damage-inputs.js'
import { arenaExecutionProperty } from '../src/npc-kibo-execution-properties.js'
const context = () => ({ state: { world: { map_id: 1052 }, combat: { npcDuel: { map_id: 1052 } } } })

test('snapshot manager retains first entity/key values and shared consumers remove only their referenced entities without refcounts', () => {
    const c = context(),
        capture = { hp: 100, sp: 12, arena_properties: { 1: { '4:0': 3 } } }
    createArenaSnapshot(c, '100', '10', { 1: capture })
    capture.hp = 9
    createArenaSnapshot(c, '101', '10', { 1: { hp: 50 }, 2: { hp: 200 } })
    assert.equal(arenaSnapshotView(c, '100').captures['1'].hp, 100)
    assert.equal(arenaSnapshotView(c, '101').captures['2'].hp, 200)
    assert.equal(createArenaSnapshot(c, '100', '10', { 1: { hp: 999 } }), false)
    bindArenaSnapshot(c, '102', '10', ['1', '1'])
    releaseArenaSnapshot(c, '102')
    assert.deepEqual(arenaSnapshotView(c, '100').missing, ['1'])
    assert.deepEqual(arenaSnapshotView(c, '101').missing, ['1'])
    assert.equal(arenaSnapshotView(c, '101').captures['2'].hp, 200)
    assert.equal(releaseArenaSnapshot(c, '102'), false)
    releaseArenaSnapshot(c, '101')
    assert.deepEqual(c.state.combat.npcDuel.arena_snapshots, {})
    assert.equal(createArenaSnapshot(c, '101', '10', { 1: { hp: 999 } }), false, 'ended owner cannot resurrect its key')
})

test('manager operations are copy-on-write, keep known absence separate from unobserved keys and are scoped to the current arena', () => {
    const c = context()
    createArenaSnapshot(c, '100', '10', { 1: { hp: 100, arena_properties: { 1: { '4:0': 3 } } } })
    const original = structuredClone(c.state)
    const draft = { state: { ...c.state, combat: { ...c.state.combat } } }
    releaseArenaSnapshot(draft, '100')
    assert.deepEqual(c.state, original)
    assert.deepEqual(arenaSnapshotView(draft, '100').missing, ['1'])
    assert.equal(arenaSnapshotView(c, '999').status, 'unobserved')
    bindArenaSnapshot(draft, '101', '0', ['1'])
    assert.deepEqual(arenaSnapshotView(draft, '101').missing, ['1'])
    c.state.world.map_id = 100
    assert.equal(arenaSnapshotView(c, '100').status, 'unobserved')
    assert.equal(releaseArenaSnapshot(c, '100'), false)
})

test('client entity rebuild and terminal serialization discard manager storage together with other local execution evidence', () => {
    const c = context()
    createArenaSnapshot(c, '100', '10', { 1: { hp: 100 } })
    const terminal = withoutArenaOrigins(c.state.combat.npcDuel)
    assert.equal(terminal.arena_snapshots, undefined)
    assert.equal(terminal.snapshot_owners, undefined)
    assert.equal(arenaSnapshotView(c, '100').status, 'known', 'terminal copy does not mutate the live draft')
    resetArenaOrigins(c)
    assert.equal(c.state.combat.npcDuel.arena_snapshots, undefined)
    assert.equal(c.state.combat.npcDuel.snapshot_owners, undefined)
    assert.equal(arenaSnapshotView(c, '100').status, 'unobserved')
})

test('real-schema creation/release is transactional with HP, avoids immediate SQLite writes and strips manager state on settlement', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-snapshot-registry' })
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
            verify_info: { source_type: 1, battle_index: '4294967500' },
        })
        const uid = '9007199254740993',
            before = structuredClone(state()),
            original = game.packet
        const dictionary = [self.uuid, enemy.uuid, uid, '18009046', '4294967500']
        const add = {
            element_info: {
                op: 1,
                uniqueId: '3',
                tar_id: '2',
                clientTmpID: 100,
                buff: { cfg_id: 4, attacker_id: '1', source_id: '1' },
                verify_info: { battle_index: '4294967501', source_type: 1, related_index: '5' },
            },
        }
        const hurt = (index) => ({
            hurt_info: {
                from_id: '1',
                tar_id: '2',
                hp_change: -7,
                element_uniqueId: '3',
                element_tempId: 100,
                dmg_inc_id: index,
            },
        })
        const report = (rows) =>
            call('BattleInfoReduce', { uint64_dic: dictionary, base_time: String(now * 1000), battle_info: rows })
        const writes = store.db.prepare('SELECT total_changes() AS n').get().n
        game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('snapshot creation packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => report([add, hurt(1)]), /snapshot creation packet fault/)
        game.packet = original
        assert.deepEqual(state(), before)
        report([add, hurt(1)])
        assert.equal(state().combat.entities[enemy.uuid].hp, before.combat.entities[enemy.uuid].hp - 7)
        const c = { state: state(), tables }
        assert.equal(arenaSnapshotView(c, uid).captures[enemy.uuid].hp, before.combat.entities[enemy.uuid].hp)
        const input = arenaElementExecutionInput(c, uid),
            captured = arenaExecutionProperty(c, input, 'source', 1)
        assert.equal(input.record.formula_trace.status, 'calculated')
        assert.equal(input.record.formula_trace.formula_id, 2)
        assert.equal(input.record.before_execution[self.uuid].numerical_grade, 0)
        // Native float operations: ATK * (A * 10000 / 10000) / 10000.
        const A = input.parameter(0),
            F = Math.fround
        assert.equal(input.record.formula_trace.value, F(F(captured * F(F(A * 10000) / 10000)) / 10000))
        const applied = structuredClone(state())
        const remove = { element_info: { op: 2, uniqueId: '3', tar_id: '2' } }
        game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('snapshot release packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => report([remove, hurt(2)]), /snapshot release packet fault/)
        game.packet = original
        assert.deepEqual(state(), applied)
        report([remove])
        assert.equal(arenaSnapshotView({ state: state() }, uid).ended, true)
        const past = { state: state(), tables }
        assert.equal(arenaExecutionProperty(past, arenaElementExecutionInput(past, uid), 'source', 1), captured)
        const triggerDictionary = [
            ...dictionary,
            '9007199254740995',
            '510110201',
            '4294967520',
            '9007199254740997',
            '14002',
        ]
        const inheritedRequest = {
            uint64_dic: triggerDictionary,
            base_time: String(now * 1000),
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        uniqueId: '6',
                        tar_id: '2',
                        buff: { cfg_id: 7, source_id: '1', attacker_id: '1' },
                        verify_info: { battle_index: '4294967520', source_type: 1, related_index: '5' },
                    },
                },
                {
                    element_info: {
                        op: 1,
                        uniqueId: '9',
                        parentUniqueId: '6',
                        tar_id: '2',
                        buff: { cfg_id: 10, source_id: '1', attacker_id: '1' },
                        verify_info: { battle_index: '4294967521', source_type: 2, related_index: '8' },
                    },
                },
                { hurt_info: { from_id: '1', tar_id: '2', element_uniqueId: '9', hp_change: -1, dmg_inc_id: 3 } },
            ],
        }
        const beforeBinding = structuredClone(state())
        game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('inherited binding packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('BattleInfoReduce', inheritedRequest), /inherited binding packet fault/)
        game.packet = original
        assert.deepEqual(state(), beforeBinding)
        call('BattleInfoReduce', inheritedRequest)
        const inheritedContext = { state: state(), tables }
        const inherited = arenaElementExecutionInput(inheritedContext, '9007199254740997')
        assert.equal(inherited.status, 'ready')
        assert.equal(inherited.record.snapshot_mode, 'inherited')
        assert.equal(inherited.record.snapshot_key, '0')
        assert.equal(arenaExecutionProperty(inheritedContext, inherited, 'source', 1), 0)
        assert.equal(arenaSnapshotView(inheritedContext, '9007199254740997').status, 'known')
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const live = structuredClone(state())
        game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('snapshot result packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('KiboDuelSurrender'), /snapshot result packet fault/)
        game.packet = original
        assert.deepEqual(state(), live)
        call('KiboDuelSurrender')
        assert.equal(state().combat.npcDuel.arena_snapshots, undefined)
        assert.equal(state().combat.npcDuel.snapshot_owners, undefined)
        const saved = JSON.parse(store.db.prepare('SELECT state FROM players WHERE account_id=?').get(session.id).state)
        assert.equal(saved.combat.npcDuel.arena_snapshots, undefined)
        assert.equal(saved.combat.npcDuel.snapshot_owners, undefined)
    } finally {
        store.close()
    }
})
