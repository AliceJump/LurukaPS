import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { recordArenaTrainerSkill, recordArenaTrainerStop } from '../src/npc-kibo-trainer-skills.js'
import { advanceArenaEnergy, arenaTiming } from '../src/npc-kibo-clock.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
const { skills } = JSON.parse(
    fs.readFileSync(new URL('../configs/npc-arena-trainer-skills.json', import.meta.url), 'utf8'),
)

function context() {
    const state = {
        world: { map_id: 1000 },
        multiCampaign: { arena_status: 4 },
        combat: {
            npcDuel: {
                map_id: 1000,
                duel_id: 501,
                trainer_guid: '123',
                regular_started_at: 100,
                end_at: 10000,
                energy: { 1: { points: 0, at: 100 }, 2: { points: 0, at: 100 } },
                trainer_skill_infos: tables
                    .get('kibo_duel_skill')
                    .map((row, i) => ({ skill_id: row.skillId, skill_slot: 701 + i })),
            },
        },
    }
    const c = { state, tables, now: 100 }
    const request = (id, index = '1') => ({
        skill: { skill_id: id },
        verify_info: { battle_index: index, source_type: 1 },
    })
    return {
        c,
        request,
        run: () => state.combat.npcDuel,
        cast: (id, index) => recordArenaTrainerSkill(c, '123', request(id, index)),
        tick: (now) => {
            c.now = now
            advanceArenaEnergy(c)
        },
    }
}

test('all six table trainer skills have extracted timeline provenance and only Player action-point injections are compiled', () => {
    assert.deepEqual(
        Object.keys(skills).map(Number).sort(),
        tables
            .get('kibo_duel_skill')
            .map((row) => row.skillId)
            .sort(),
    )
    for (const row of Object.values(skills)) assert.equal(row.fps, 60)
    const parameters = (a) => Array.from({ length: 26 }, (_, index) => (index === 0 ? a : index === 6 ? 10000 : 0))
    assert.deepEqual(skills[19999903].effects, [
        { kind: 'points', value: 2, frame: 16, element_id: 199999013, value_formula: 5, parameters: parameters(2) },
    ])
    assert.deepEqual(skills[19999904].effects, [
        {
            kind: 'interval_percent',
            value: -0.5,
            duration_ms: 10000,
            frame: 16,
            element_id: 199999014,
            value_formula: 3,
            parameters: parameters(-5000),
        },
    ])
    assert.equal(skills[19999903].effects.length, 1, 'the Self306 injection must not change the Player clock')
})

test('trainer action points apply at frame16 once, respect cap and camp, and duplicate or network reports cannot mint points', () => {
    const f = context(),
        interval = arenaTiming(tables, 501).schedule[0].interval
    f.cast(19999903)
    f.cast(19999903)
    recordArenaTrainerSkill(f.c, '123', { ...f.request(19999903, '2'), verify_info: { source_type: 5 } })
    assert.equal(f.run().trainer_skills[19999903].charges, 2)
    f.tick(100.25)
    assert.ok(Math.abs(f.run().energy[1].points - (0.25 * 100) / interval) < 0.0001)
    f.tick(101)
    assert.ok(Math.abs(f.run().energy[1].points - (200 + 100 / interval)) < 0.0001)
    assert.ok(Math.abs(f.run().energy[2].points - 100 / interval) < 0.0001)
    const points = f.run().energy[1].points
    f.tick(101)
    assert.equal(f.run().energy[1].points, points)
    assert.deepEqual(f.run().trainer_effects, [])
    f.tick(1000)
    assert.equal(f.run().energy[1].points, arenaTiming(tables, 501).max)
})

test('recovery interval percent expires within a delayed tick and composes with the table recovery schedule', () => {
    const f = context(),
        timing = arenaTiming(tables, 501)
    f.cast(19999904)
    f.tick(112)
    const expected = ((12 + 10) * 100) / timing.schedule[0].interval
    assert.ok(Math.abs(f.run().energy[1].points - Math.min(timing.max, expected)) < 0.0001)
    assert.ok(
        Math.abs(f.run().energy[2].points - Math.min(timing.max, (12 * 100) / timing.schedule[0].interval)) < 0.0001,
    )
    assert.deepEqual(f.run().trainer_effects, [])
    const g = context()
    g.run().duel_id = 1001
    g.c.now = 116
    g.cast(19999904)
    g.tick(130)
    const schedule = arenaTiming(tables, 1001).schedule
    const from = 100,
        to = 130,
        start = 116 + 16 / 60,
        end = start + 10
    let integral = 0
    const boundaries = [from, to, start, end, ...schedule.map((x) => 100 + x.at)]
        .filter((x) => x >= from && x <= to)
        .sort((a, b) => a - b)
    for (let i = 1; i < boundaries.length; i++) {
        const middle = (boundaries[i] + boundaries[i - 1]) / 2
        const interval = schedule.findLast((x) => 100 + x.at <= middle).interval
        integral += (((boundaries[i] - boundaries[i - 1]) * 100) / interval) * (middle >= start && middle < end ? 2 : 1)
    }
    assert.ok(Math.abs(g.run().energy[1].points - Math.min(arenaTiming(tables, 1001).max, integral)) < 0.0001)
})

test('trainer casts enforce equipped skill, actor, native limited charges and cooldown without mutating a rejected draft', () => {
    const f = context(),
        before = structuredClone(f.c.state)
    assert.throws(() => recordArenaTrainerSkill(f.c, '999', f.request(19999903)), /actor mismatch/)
    assert.deepEqual(f.c.state, before)
    const denied = context()
    denied.run().trainer_skill_infos = []
    assert.throws(() => denied.cast(19999903), /not equipped/)
    f.cast(19999903)
    const after = structuredClone(f.c.state)
    assert.throws(() => f.cast(19999903, '2'), /cooling down/)
    assert.deepEqual(f.c.state, after)
    f.c.now = 200
    f.cast(19999903, '2')
    f.c.now = 300
    f.cast(19999903, '3')
    f.c.now = 1000
    assert.throws(() => f.cast(19999903, '4'), /no remaining charges/)
    assert.equal(f.run().trainer_skills[19999903].charges, 0, 'type3 does not regenerate charges')
})

test('the matching millisecond skill stop cancels only unexecuted frames and cannot refund charges or remove active buffs', () => {
    const f = context()
    recordArenaTrainerSkill(f.c, '123', { ...f.request(19999903), op_time: '1800000000000' })
    const stop = (related, time) =>
        recordArenaTrainerStop(f.c, '123', {
            skill_id: '19999903',
            op_time: time,
            verify_info: { related_index: related },
        })
    stop('2', '1800000000100')
    assert.equal(f.run().trainer_effects.length, 1)
    stop('1', '1799999999999')
    assert.equal(f.run().trainer_effects.length, 1)
    stop('1', '1800000000100')
    assert.deepEqual(f.run().trainer_effects, [])
    assert.equal(f.run().trainer_skills[19999903].charges, 2)
    f.tick(101)
    assert.ok(f.run().energy[1].points < 200)
    const g = context()
    recordArenaTrainerSkill(g.c, '123', { ...g.request(19999904), op_time: '1800000000000' })
    recordArenaTrainerStop(g.c, '123', {
        skill_id: '19999904',
        op_time: '1800000000500',
        verify_info: { related_index: '1' },
    })
    assert.equal(g.run().trainer_effects.length, 1, 'a frame16 effect remains after normal animation completion')
    recordArenaTrainerStop(g.c, '123', {
        skill_id: '19999904',
        op_time: '1800000000100',
        verify_info: { related_index: '1' },
    })
    assert.equal(g.run().trainer_effects.length, 1, 'an older duplicate stop cannot rewrite a completed cast')
    const h = context()
    recordArenaTrainerSkill(h.c, '123', { ...h.request(19999904), op_time: '1800000000000' })
    h.tick(101)
    recordArenaTrainerStop(h.c, '123', {
        skill_id: '19999904',
        op_time: '1800000000100',
        verify_info: { related_index: '1' },
    })
    assert.equal(h.run().trainer_effects.length, 1, 'already authoritative effects are not retroactively undone')
})

test('live trainer protocol preserves effect receipts across reconnect and rolls back failures without immediate SQLite writes', () => {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, request) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-trainer-skills' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        call('ControlMapAI', { control_type: 1, status: 1 })
        const trainer = state().combat.npcDuel.trainer_guid
        const request = {
            unit_id: trainer,
            skill: { skill_id: 19999903 },
            verify_info: { battle_index: '90', source_type: 1 },
        }
        const previous = state().combat.npcDuel.energy[1].points
        const writes = store.db.prepare('SELECT total_changes() AS n').get().n
        call('SkillStart', request)
        call('SkillStart', request)
        now += 1
        const snapshot = structuredClone(state().combat),
            original = game.packet
        game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboDuelArenaActionPointSync') throw Error('trainer point packet failure')
            return original.call(this, name, ...args)
        }
        assert.throws(() => game.tick(session.id, session), /trainer point packet failure/)
        game.packet = original
        assert.deepEqual(state().combat, snapshot)
        const tick = game.tick(session.id, session)
        assert.ok(tick.length)
        assert.ok(state().combat.npcDuel.energy[1].points >= previous + 200)
        assert.equal(state().combat.npcDuel.trainer_skills[19999903].charges, 2)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const receipts = structuredClone(state().combat.npcDuel.trainer_skills)
        session = {}
        call('EnterGame', { open_id: 'npc-trainer-skills' })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        assert.deepEqual(state().combat.npcDuel.trainer_skills, receipts)
        call('SkillStart', request)
        assert.deepEqual(state().combat.npcDuel.trainer_skills, receipts)
    } finally {
        store.close()
    }
})
