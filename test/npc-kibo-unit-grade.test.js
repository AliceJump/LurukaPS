import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPetAttributes } from '../src/kibo-arena-attributes.js'
import { initializeNpcDuelBattle } from '../src/npc-kibo-battle.js'
import { arenaNativeSummonOwner, arenaUnitGrade } from '../src/npc-kibo-unit-grade.js'
import { arenaDamageInput, recordArenaDamageElement } from '../src/npc-kibo-damage-inputs.js'
import { arenaFormulaEntity } from '../src/npc-kibo-formula-context.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function context() {
    const state = {
        player: {
            basic_info: { id: 1 },
            heros_info: {
                heros: [
                    { guid: '123', hero_grade: 3, hero_star: 6 },
                    { guid: '124', hero_grade: 6 },
                ],
            },
        },
        world: { map_id: 1052 },
        multiCampaign: { duel_id: 501, map_id: 1052, start_time: 100, arena_status: 4 },
    }
    const data = arenaPetAttributes(tables, 500020, 5)
    const run = initializeNpcDuelBattle(
        tables,
        state,
        {
            hero_info: { hero_guid: '123', hero_grade: 3, hero_star: 6 },
            infos: [{ pet_guid: { guid: '456' }, pet_conf_id: 500020, pet_lv: 5, ...data }],
        },
        100,
    )
    state.combat.summons = {}
    return {
        c: { state, tables, now: 100 },
        run,
        self: Object.values(run.actors).find((a) => a.camp === 1),
        enemy: Object.values(run.actors).find((a) => a.camp === 2),
    }
}

test('standard roster grade is native zero in both camps while the spawned trainer uses wire hero_grade', () => {
    const { c, run } = context()
    assert.equal(run.trainer_grade, 3)
    assert.deepEqual(arenaUnitGrade(c, '123'), { status: 'resolved', value: 3, via: 'hero-grade', hero: '123' })
    c.state.player.heros_info.heros[0].hero_grade = 5
    assert.equal(arenaUnitGrade(c, '123').value, 3, 'profile edits do not change an already spawned HeroData')
    for (const actor of Object.values(run.actors)) {
        assert.deepEqual(actor.native_owner, { status: 'known', guid: '0', kind: 'none', via: 'arena-roster' })
        assert.deepEqual(arenaUnitGrade(c, actor.uuid), { status: 'resolved', value: 0, via: 'no-native-owner' })
        assert.notEqual(c.state.combat.entities[actor.uuid].owner_id, '0', 'logical damage attribution stays separate')
    }
    assert.deepEqual(
        arenaUnitGrade(c, '124'),
        { status: 'unobserved' },
        'owned but unspawned heroes are not live actors',
    )
    assert.deepEqual(
        arenaUnitGrade(c, String(run.npc_id)),
        { status: 'unobserved' },
        'NPC player/master is not a HeroEntity',
    )
})

test('SetOwner flattens only IndependentEntity once; numerical grade never follows arbitrary logical owner chains', () => {
    const { c, self, run } = context(),
        summons = c.state.combat.summons
    const scope = { generation: run.generation, epoch: 0 }
    const heroOwner = arenaNativeSummonOwner(c, '123')
    assert.deepEqual(heroOwner, { status: 'known', guid: '123', kind: 'hero', via: 'summon-create' })
    summons['1000'] = { summon_type: 3, owner_id: '123', native_owner: heroOwner, native_owner_scope: scope }
    const flattened = arenaNativeSummonOwner(c, '1000')
    assert.deepEqual(flattened, { ...heroOwner, via: 'independent-owner' })
    summons['1001'] = { summon_type: 4, owner_id: '1000', native_owner: flattened, native_owner_scope: scope }
    assert.equal(arenaUnitGrade(c, '1001').value, 3)
    summons['1000'].native_owner = { status: 'known', guid: '0', kind: 'none', via: 'fixture' }
    assert.equal(arenaUnitGrade(c, '1001').value, 3, 'SetOwner copied the handle at creation, not a dynamic chain')
    assert.equal(arenaNativeSummonOwner(c, '1000').kind, 'none')
    summons['1002'] = {
        summon_type: 4,
        owner_id: '1001',
        native_owner: arenaNativeSummonOwner(c, '1001'),
        native_owner_scope: scope,
    }
    assert.deepEqual(arenaUnitGrade(c, '1002'), { status: 'resolved', value: 0, via: 'direct-owner-not-hero' })
    summons['1003'] = { summon_type: 3, owner_id: '123', native_owner_scope: scope }
    assert.deepEqual(arenaNativeSummonOwner(c, '1003'), { status: 'unobserved' })
    delete c.state.combat.npcDuel.actors[self.uuid].native_owner
    assert.deepEqual(
        arenaUnitGrade(c, self.uuid),
        { status: 'unobserved' },
        'legacy records do not infer owner from trainer',
    )
    assert.deepEqual(arenaNativeSummonOwner(c, '9999'), { status: 'unobserved' })
    assert.deepEqual(arenaNativeSummonOwner(c, '0'), { status: 'unobserved' })
})

test('numerical grade capture supports summon attackers without inventing their ordinary battle attributes', () => {
    const { c, run, self, enemy } = context()
    c.state.combat.summons['1000'] = {
        summon_type: 4,
        native_owner: arenaNativeSummonOwner(c, '123'),
        native_owner_scope: { generation: run.generation, epoch: 0 },
    }
    recordArenaDamageElement(c, {
        op: 1,
        uniqueId: '1200',
        tar_id: enemy.uuid,
        buff: {
            cfg_id: 503001101,
            attacker_id: '1000',
            source_id: self.uuid,
            source_behavior_id: ((1n << 32n) | 5030012n).toString(),
        },
    })
    const input = arenaDamageInput(c, { tar_id: enemy.uuid, element_uniqueId: '1200', skill_id: 5030012 })
    assert.deepEqual(input.record.before_execution['1000'], { numerical_grade: 3 })
    const item = { target: 1, operation: -19, custom_int: 0, prefix: 1 }
    c.state.combat.npcDuel.trainer_grade = 6
    assert.equal(arenaFormulaEntity(c, input, item), 3)
    assert.equal(arenaFormulaEntity(c, input, item, { phase: 'after' }), 6)
    assert.throws(() => arenaFormulaEntity(c, input, { ...item, operation: 1 }), /actor unavailable/)
    assert.throws(() => arenaFormulaEntity(c, input, { ...item, prefix: 2 }), /prefix semantics unavailable/)
    assert.equal(run.trainer_grade, 3, 'damage input capture replaces its runtime branch')
})

test('grade providers reject absent wire grade, stale maps, terminal runs and unloaded incarnations', () => {
    const { c, self } = context(),
        run = c.state.combat.npcDuel
    for (const value of [undefined, -1, 1.5, NaN, 2147483648]) {
        run.trainer_grade = value
        assert.deepEqual(arenaUnitGrade(c, '123'), { status: 'unobserved' })
    }
    run.trainer_grade = 0
    assert.equal(arenaUnitGrade(c, '123').value, 0)
    run.entities_sent = false
    assert.deepEqual(arenaUnitGrade(c, self.uuid), { status: 'unobserved' })
    delete run.entities_sent
    run.result = { result: 1 }
    assert.deepEqual(arenaNativeSummonOwner(c, self.uuid), { status: 'unobserved' })
    delete run.result
    c.state.world.map_id++
    assert.deepEqual(arenaUnitGrade(c, self.uuid), { status: 'unobserved' })
})

test('real summon schema keeps native ownership through retry, rolls back packet failure, and retires it on reconnect', () => {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-native-owner' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        const trainer = state().combat.npcDuel.trainer_guid
        const request = {
            unit_id: trainer,
            summon_info: { config_id: 300001, summon_type: 3, skill_id: 20011 },
            verify_info: { battle_index: '4294967800' },
        }
        const first = call('CreateSummon', request),
            id = first.find((packet) => packet.id === 11148).data.unit_id
        assert.deepEqual(state().combat.summons[id].native_owner, {
            status: 'known',
            guid: trainer,
            kind: 'hero',
            via: 'summon-create',
        })
        assert.deepEqual(call('CreateSummon', request), first)
        const before = structuredClone(state()),
            original = game.packet
        const child = {
            ...request,
            unit_id: id,
            summon_info: { ...request.summon_info, summon_type: 4 },
            verify_info: { battle_index: '4294967801' },
        }
        game.packet = function (name, ...args) {
            if (name === 'SCProtoCreateSummon') throw Error('owner packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('CreateSummon', child), /owner packet fault/)
        game.packet = original
        assert.deepEqual(state(), before)
        const childId = call('CreateSummon', child).find((packet) => packet.id === 11148).data.unit_id
        assert.deepEqual(state().combat.summons[childId].native_owner, {
            status: 'known',
            guid: trainer,
            kind: 'hero',
            via: 'independent-owner',
        })
        assert.equal(state().combat.summons[childId].owner_id, id, 'logical owner remains the independent entity')
        const writes = store.db.prepare('SELECT total_changes() AS n').get().n
        assert.equal(arenaUnitGrade({ state: state() }, childId).value, state().combat.npcDuel.trainer_grade)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes, 'grade lookup does not persist')
        store.transact(session.id, 0, (s) => {
            const hero = s.player.heros_info.heros.find((row) => row.guid === trainer)
            hero.hero_grade = 4
            hero.hero_star = 6
            delete Object.values(s.combat.npcDuel.actors)[0].native_owner
        })
        session = {}
        call('EnterGame', { open_id: 'npc-native-owner' })
        assert.equal(state().multiCampaign, undefined)
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        assert.deepEqual(arenaUnitGrade({ state: state() }, childId), { status: 'unobserved' })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        assert.equal(
            arenaUnitGrade({ state: state() }, trainer).value,
            4,
            'entity rebuild uses the newly sent grade, not the old wire value or hero_star',
        )
        assert.deepEqual(
            arenaUnitGrade({ state: state() }, childId),
            { status: 'unobserved' },
            'old incarnation owner is not reused after entity rebuild',
        )
        assert.ok(
            Object.values(state().combat.npcDuel.actors).every(
                (actor) => arenaUnitGrade({ state: state() }, actor.uuid).value === 0,
            ),
        )
        call('CreateSummon', request)
        assert.equal(state().combat.summons[childId], undefined, 'new session creation retires old summon receipts')
    } finally {
        store.close()
    }
})
