import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { initializeNpcDuelBattle, recordNpcArenaMovement } from '../src/npc-kibo-battle.js'
import { arenaPetAttributes } from '../src/kibo-arena-attributes.js'
import { advanceArenaPetAI, arenaPetAIProfile } from '../src/npc-kibo-pet-ai.js'
import { forkNpcArenaRuntime } from '../src/npc-kibo-service.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)

function context() {
    const state = {
        player: { basic_info: { id: 1 } },
        world: { map_id: 1052 },
        multiCampaign: { duel_id: 501, map_id: 1052, start_time: 100, arena_status: 4 },
    }
    const attributes = arenaPetAttributes(tables, 500097, 1)
    const run = initializeNpcDuelBattle(
        tables,
        state,
        {
            hero_info: { hero_guid: '123' },
            infos: [{ pet_guid: { guid: '456' }, pet_conf_id: 500097, pet_lv: 1, ...attributes }],
        },
        100,
    )
    run.regular_started_at = 100
    const self = Object.values(run.actors).find((actor) => actor.camp === 1),
        enemy = Object.values(run.actors).find((actor) => actor.camp === 2)
    run.in_fight = {
        [self.uuid]: { move: { pos: { x: 13000, y: 9995, z: 13400 }, angle: 0 }, entered_at: 100 },
        [enemy.uuid]: { move: { pos: { x: 13000, y: 9995, z: 14400 }, angle: 180 }, entered_at: 100 },
    }
    const packets = []
    const c = {
        state,
        tables,
        now: 100,
        randomInt: (lo) => lo,
        pushBefore: (name, data) => {
            const entry = protocol.byName.get(name)
            packets.push({ name, data: protocol.decode(entry.rsp, protocol.encode(entry.rsp, data)) })
        },
    }
    return {
        c,
        self,
        enemy,
        packets,
        tick: (now) => {
            c.now = now
            packets.length = 0
            advanceArenaPetAI(c)
            return packets
        },
    }
}

test('all table-linked NPC ordinary pet skills have shared CBT3 AI profiles and keyed skill logic', () => {
    const pets = new Set(
        tables
            .get('kibo_duel')
            .filter((row) => tables.find('kibo_duel_map', row.mapId))
            .flatMap((row) => row.enemy.split('|').filter(Boolean).map(Number)),
    )
    for (const id of pets) {
        const profile = arenaPetAIProfile(tables, id)
        assert.ok(profile, `pet ${id}`)
        for (const skill of profile.skills) {
            assert.equal(skill.logic.skillId, skill.skill_id)
            assert.ok(skill.logic.kiBoVersusCoolDown > 0)
        }
    }
    assert.equal(arenaPetAIProfile(tables, 500097).skills[0].logic.kiBoVersusCoolDown, 3000)
    assert.equal(arenaPetAIProfile(tables, 500097).lockRange, 3.5, 'pet.aimRange overrides graph lock range')
})

test('both camps approach beyond lock range; movement remains a client path command with no fake HP or position', () => {
    const f = context(),
        hp = f.c.state.combat.entities[f.enemy.uuid].hp,
        world = structuredClone(f.c.state.world)
    const commands = f.tick(101).filter((packet) => packet.name === 'SCProtoKiboStartMove')
    assert.equal(commands.length, 2)
    assert.equal(commands[0].data.target_uuid, f.enemy.uuid)
    assert.equal(commands[1].data.target_uuid, f.self.uuid)
    assert.equal(commands[0].data.move_action_type, 1, 'IfEngage uses the configured approach action')
    assert.ok(commands[0].data.precision > 0 && commands[0].data.precision <= 3.5)
    assert.equal(f.tick(102).length, 0, 'unchanged tracked target does not restart the move every tick')
    assert.equal(f.c.state.combat.entities[f.enemy.uuid].hp, hp)
    assert.deepEqual(f.c.state.world, world)
    assert.equal(f.c.state.combat.npcDuel.in_fight[f.self.uuid].move.pos.z, 13400)
})

test('the native capsule half-height cap prevents casting just beyond actual melee surface range', () => {
    assert.equal(arenaPetAIProfile(tables, 500001).radius, 0.9)
    assert.equal(arenaPetAIProfile(tables, 500022).radius, 0.9)
    const f = context()
    f.self.config_id = 500022
    f.enemy.config_id = 500083
    const run = f.c.state.combat.npcDuel
    run.in_fight[f.self.uuid].move.pos.z = 14060
    const initial = f.tick(101)
    assert.equal(initial.filter((packet) => packet.name === 'SCProtoSkillStartSync').length, 0)
    const move = initial.find((packet) => packet.name === 'SCProtoKiboStartMove' && packet.data.uuid === f.self.uuid)
    assert.ok(Math.abs(move.data.precision - 3.3) < 1e-5)
    recordNpcArenaMovement(f.c, { uuid: f.self.uuid, info: { pos: { x: 13000, y: 9995, z: 14100 } } })
    assert.ok(
        f.tick(102).some((packet) => packet.name === 'SCProtoSkillStartSync' && packet.data.unit_id === f.self.uuid),
    )
})

test('the arena collider runtime override takes precedence over the raw unit collider', () => {
    const isolated = new Tables(cfg.tables),
        pet = isolated.find('pet', 500022)
    isolated.cache.set(
        'unit_collider_runtime',
        isolated
            .get('unit_collider_runtime')
            .map((row) => (row.id === pet.unitId ? { ...row, kiboColliderList: '0|0.3|0.5|1.8' } : row)),
    )
    assert.equal(arenaPetAIProfile(isolated, pet.id).radius, 0.5)
})

test('actual movement receipts enable table-timed skills, shared cooldowns and priority without replaying subskills', () => {
    const f = context()
    f.tick(100)
    recordNpcArenaMovement(f.c, { uuid: f.self.uuid, info: { pos: { x: 13000, y: 9995, z: 14090 } } })
    let packets = f.tick(101)
    const first = packets.filter((packet) => packet.name === 'SCProtoSkillStartSync')
    assert.equal(first.length, 2)
    for (const { data } of first) {
        assert.equal(data.skill.slot, 1)
        assert.equal(data.skill.index, 0)
        assert.equal(data.skill.cd_time_p, '104000')
        assert.equal(data.skill.begin_time, '101000')
        assert.equal(data.skill.gcd, '2000')
        assert.ok([f.self.uuid, f.enemy.uuid].includes(data.skill.lock_id))
        assert.notEqual(data.unit_id, data.skill.lock_id)
    }
    assert.equal(f.tick(102).filter((packet) => packet.name === 'SCProtoSkillStartSync').length, 0)
    assert.equal(f.tick(103).filter((packet) => packet.name === 'SCProtoSkillStartSync').length, 0)
    assert.equal(f.tick(104).filter((packet) => packet.name === 'SCProtoSkillStartSync').length, 2)
    assert.equal(f.tick(108).filter((packet) => packet.name === 'SCProtoSkillStartSync')[0].data.skill.slot, 2)
})

test('trainer-only pause allows field combat; pet pause stops active paths; intro and terminal states never run field AI', () => {
    const f = context()
    f.c.state.multiCampaign.arena_status = 6
    assert.equal(f.tick(100).length, 0)
    f.c.state.multiCampaign.arena_status = 4
    f.c.state.combat.npcDuel.ai_control = { 1: 1 }
    assert.equal(f.tick(101).length, 2)
    f.c.state.combat.npcDuel.ai_control = { 2: 1 }
    assert.equal(f.tick(102).filter((packet) => packet.name === 'SCProtoKiboStopMove').length, 2)
    assert.equal(f.tick(103).length, 0)
    f.c.state.multiCampaign.arena_status = 5
    assert.equal(f.tick(104).length, 0)
})

test('pet decision edits preserve small-draft rollback isolation and exclude dead, returned and friendly targets', () => {
    const f = context()
    f.tick(100)
    const original = f.c.state,
        snapshot = structuredClone(original)
    f.c.state = forkNpcArenaRuntime(original)
    recordNpcArenaMovement(f.c, { uuid: f.self.uuid, info: { pos: { x: 13000, y: 9995, z: 14100 } } })
    assert.equal(f.tick(101).filter((packet) => packet.name === 'SCProtoSkillStartSync').length, 2)
    assert.deepEqual(original, snapshot)
    delete f.c.state.combat.npcDuel.in_fight[f.enemy.uuid]
    assert.equal(f.tick(105).filter((packet) => packet.name === 'SCProtoSkillStartSync').length, 0)
})

test('Game.tick drives server pet AI after the movie without immediate SQLite writes', () => {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    try {
        call('EnterGame', { open_id: 'npc-field-ai' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', 501).dungeonId })
        call('StartDungeonClientOk')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = store.load(session.id).state.combat.npcDuel.intro_until
        game.tick(session.id, session)
        for (const uuid of Object.keys(store.load(session.id).state.combat.npcDuel.in_fight))
            call('KiboCastUltraSkill', { guid: uuid, cast_ultra_skill: false })
        call('ControlMapAI', { control_type: 1, status: 1 })
        const changes = store.db.prepare('SELECT total_changes() AS n').get().n
        now++
        assert.equal(game.tick(session.id, session).filter((packet) => packet.id === 11706).length, 2)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes)
    } finally {
        store.close()
    }
})
