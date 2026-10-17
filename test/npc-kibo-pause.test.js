import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaSpConfig } from '../src/npc-kibo-sp.js'
import { npcArenaOutcome } from '../src/npc-kibo-result.js'
import { arenaTiming } from '../src/npc-kibo-clock.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

function fixture(firstOnly = false, duelId = 501) {
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
    call('EnterGame', { open_id: 'npc-pause' })
    call('KiboDuelGetGroup', { u32: duelId })
    const duel = tables.find('kibo_duel', duelId)
    if (duel.kiboLock) {
        const saved = state(),
            group = structuredClone(saved.kiboDuelGroups[0])
        const used = new Set(group.pet_guids.filter((pet) => !pet.is_trial).map((pet) => pet.id))
        const available = saved.pets.filter((pet) => !used.has(pet.guid))
        for (let i = 0; i < group.pet_guids.length; i++)
            if (group.pet_guids[i].id === '0') group.pet_guids[i] = { id: available.shift().guid, is_trial: false }
        call('KiboDuelGroupChange', { type: 6, group })
    }
    if (!duel.kiboLock) {
        const saved = state()
        call('KiboDuelGroupChange', {
            type: 6,
            group: {
                slot: 1,
                duel_id: duelId,
                hero: saved.player.heros_info.heros[0].guid,
                pet_guids: saved.pets.slice(0, 8).map((pet) => ({ id: pet.guid, is_trial: false })),
                hero_skills: duel.skillList
                    .split('|')
                    .filter(Boolean)
                    .map((id, index) => ({ skill_id: Number(id), skill_lv: 1, skill_slot: 701 + index, type: 1 })),
            },
        })
        call('SetKiboDuelCurGroup', { type: 6, cur_group: 1 })
    }
    call('MultiCampaignCreate', { dungeon_id: duel.dungeonId })
    call('MultiCampaignPlayerLoaded')
    call('MultiCampaignPlayerLoadFinish')
    if (!firstOnly) {
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        call('ControlMapAI', { control_type: 0, status: 1 })
        game.tick(session.id, session)
    }
    return {
        store,
        game,
        session,
        call,
        state,
        run: () => state().combat.npcDuel,
        now: () => now,
        set: (value) => {
            now = value
        },
        tick: () => game.tick(session.id, session),
        relogin: () => {
            session = {}
            return call('EnterGame', { open_id: 'npc-pause' })
        },
        close: () => store.close(),
    }
}

for (const firstOnly of [true, false]) {
    test(`entity readiness resends paused ${firstOnly ? 'FIRST' : 'REGULAR'} after relogin so the 75% loading page can enter`, () => {
        const f = fixture(firstOnly)
        try {
            f.call('GamePause', { operate: true })
            const before = f.run(),
                phase = firstOnly ? 3 : 4
            f.set(f.now() + 600)
            assert.equal(f.relogin().find((packet) => packet.id === 11800).data.status, phase)
            f.call('StartDungeonClientOk')
            if (!firstOnly) {
                const snapshot = f.state(),
                    original = f.game.packet
                f.game.packet = function (name, ...args) {
                    if (name === 'SCProtoKiboDuelArenaInfoSync') throw Error('loading readiness packet fault')
                    return original.call(this, name, ...args)
                }
                assert.throws(() => f.call('MultiCampaignPlayerLoadFinish'), /loading readiness packet fault/)
                f.game.packet = original
                assert.deepEqual(f.state(), snapshot, 'failed status sync must not consume the readiness transition')
            }
            const packets = f.call('MultiCampaignPlayerLoadFinish'),
                info = packets.find((packet) => packet.id === 11800)
            assert.ok(
                info,
                'the initial login status precedes HasReportedPlayerLoadFinish; readiness must trigger CheckEnter again',
            )
            assert.equal(info.data.status, phase)
            assert.equal(info.data.status_endtime, String(Math.ceil(firstOnly ? before.first_until : before.end_at)))
            assert.equal(f.run().pause.server_at, before.pause.server_at)
            assert.deepEqual(f.run().energy, before.energy)
            assert.deepEqual(f.run().scores, before.scores)
            assert.equal(f.run().start_time, before.start_time)
            assert.deepEqual(f.tick(), [])
            assert.ok(
                !f.call('MultiCampaignPlayerLoadFinish').some((packet) => packet.id === 11800),
                'duplicate readiness cannot restart UI timers',
            )
            if (!firstOnly) {
                const hand = packets.find((packet) => packet.id === 11804).data.pet_guids
                assert.ok(
                    Object.values(f.run().actors)
                        .filter((actor) => actor.camp === 1)
                        .every((actor) => hand.includes(actor.source_guid) === !f.run().in_fight[actor.uuid]),
                )
                assert.equal(
                    packets.find((packet) => packet.id === 11814).data.current_points,
                    Math.floor(before.energy[1].points),
                )
                assert.ok(packets.some((packet) => packet.id === 11805))
            }
        } finally {
            f.close()
        }
    })
}

test('server pause freezes battle timeout, scores, action/SP energy, paths and deadlines, then resyncs the resumed deadline', () => {
    const f = fixture(false, 1001)
    try {
        const start = f.now(),
            base = f.run(),
            pet = Object.values(base.actors).find((actor) => actor.camp === 1)
        const ordinary = arenaSpConfig(tables, pet.config_id).skills.find((skill) => skill.skill_slot === 1)
        f.store.transact(f.session.id, 0, (state) => {
            const run = state.combat.npcDuel
            run.gcd_until[1] = start * 1000 + 3000
            run.ai_next_at = start * 1000 + 5000
            run.pet_ai = {
                [pet.uuid]: {
                    ready_at: start * 1000,
                    gcd_until: start * 1000 + 2000,
                    moving: true,
                    cooldowns: { 1: start * 1000 + 10000 },
                    groups: { 'self:3': start * 1000 + 8000 },
                },
            }
            run.pet_sp[pet.uuid].lock_until = start * 1000 + 9000
            run.arena_casts = {
                [pet.uuid]: {
                    skill_id: ordinary.skill_id,
                    slot: 1,
                    origin: 'server',
                    network_index: '0',
                    at: start * 1000,
                    ended: false,
                },
            }
        })
        f.call('SkillStart', {
            unit_id: base.trainer_guid,
            skill: { skill_id: 19999904 },
            op_time: String(start * 1000),
            verify_info: { battle_index: '1', source_type: 1 },
        })
        const paused = f.call('GamePause', { operate: true, game_time: String(start * 1000 + 100) })
        assert.ok(paused.some((packet) => packet.id === 11707))
        const frozen = structuredClone(f.run()),
            hp = f.state().combat.entities[pet.uuid].hp
        const writes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        f.set(start + 600)
        assert.deepEqual(f.tick(), [])
        assert.equal(npcArenaOutcome(f.state(), f.now()), null)
        assert.deepEqual(f.run(), frozen)
        const enemy = Object.values(base.actors).find((actor) => actor.camp === 2)
        f.call('BattleInfoReduce', {
            uint64_dic: [enemy.uuid, pet.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hp } }],
        })
        assert.equal(f.state().combat.entities[pet.uuid].hp, hp)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const resumed = f.call('GamePause', { operate: false, game_time: String((start + 600) * 1000 + 100) })
        assert.equal(resumed.find((packet) => packet.id === 11800).data.status_endtime, String(base.end_at + 600))
        const run = f.run()
        assert.equal(run.pause, undefined)
        assert.equal(run.start_time, base.start_time)
        assert.equal(run.regular_started_at, frozen.regular_started_at + 600)
        assert.deepEqual(run.scores, frozen.scores)
        assert.equal(run.energy[1].points, frozen.energy[1].points)
        assert.equal(run.gcd_until[1], frozen.gcd_until[1] + 600000)
        assert.equal(run.ai_next_at, frozen.ai_next_at + 600000)
        assert.equal(run.pet_ai[pet.uuid].cooldowns[1], frozen.pet_ai[pet.uuid].cooldowns[1] + 600000)
        assert.equal(run.pet_sp[pet.uuid].lock_until, frozen.pet_sp[pet.uuid].lock_until + 600000)
        assert.equal(run.trainer_effects[0].at_ms, frozen.trainer_effects[0].at_ms + 600000)
        assert.equal(run.trainer_skills[19999904].ready_at, frozen.trainer_skills[19999904].ready_at + 600000)
        assert.equal(run.in_fight[pet.uuid].entered_report_at, frozen.in_fight[pet.uuid].entered_at)
        f.call('SkillStart', {
            unit_id: pet.uuid,
            skill: { skill_id: ordinary.skill_id },
            op_time: String(start * 1000 + 100),
            verify_info: { battle_index: '44', source_type: 5 },
        })
        assert.equal(
            f.run().arena_casts[pet.uuid].network_index,
            '44',
            'a shifted gameplay origin must not reject real pre-pause network evidence',
        )
        assert.equal(npcArenaOutcome(f.state(), f.now()), null)
    } finally {
        f.close()
    }
})

test('first-pick pause cannot auto-confirm and resume moves only its own deadline', () => {
    const f = fixture(true)
    try {
        const start = f.now(),
            until = f.run().first_until
        f.call('GamePause', { operate: true, game_time: String(start * 1000) })
        f.set(start + 100)
        assert.deepEqual(f.tick(), [])
        assert.equal(f.state().multiCampaign.arena_status, 3)
        f.call('GamePause', { operate: false, game_time: String((start + 100) * 1000) })
        assert.equal(f.run().first_until, until + 100)
        assert.equal(f.run().energy, undefined)
        f.set(until + 99)
        f.tick()
        assert.equal(f.state().multiCampaign.arena_status, 3)
        f.set(until + 100)
        f.tick()
        assert.equal(f.state().multiCampaign.arena_status, 6)
    } finally {
        f.close()
    }
})

test('explicit first confirmation works under guide pause and presentation resumes without inheriting selection wait time', () => {
    const f = fixture(true)
    try {
        const start = f.now()
        f.call('GamePause', { operate: true })
        f.set(start + 100)
        const packets = f.call('KiboDuelArenaFirstConfirmReq')
        assert.ok(packets.some((packet) => packet.id === 11803))
        assert.equal(f.state().multiCampaign.arena_status, 6)
        const intro = f.run().intro_until
        assert.ok(f.run().pause)
        f.set(start + 200)
        assert.deepEqual(f.tick(), [])
        f.call('KiboDuelArenaFirstConfirmReq')
        assert.equal(f.run().intro_until, intro, 'retry does not restart the movie')
        const resumed = f.call('GamePause', { operate: false })
        assert.equal(f.run().pause, undefined)
        assert.equal(f.run().intro_until, intro + 100)
        assert.equal(resumed.find((packet) => packet.id === 11800).data.status, 6)
        f.set(intro + 99)
        f.tick()
        assert.equal(f.state().multiCampaign.arena_status, 6)
        f.set(intro + 100)
        f.tick()
        assert.equal(f.state().multiCampaign.arena_status, 4)
        assert.equal(f.run().pause, undefined)
        assert.equal(f.run().energy[1].points, arenaTiming(tables, 501).initial)
    } finally {
        f.close()
    }
})

test('guide deployment spends once while simulation stays frozen and starts cooldown at the frozen gameplay instant', () => {
    const f = fixture()
    try {
        const start = f.now(),
            timing = arenaTiming(tables, 501)
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.energy[1].points = 300
        })
        f.call('GamePause', { operate: true })
        const frozen = f.run(),
            [pet, next] = Object.values(frozen.actors).filter(
                (actor) => actor.camp === 1 && !frozen.in_fight[actor.uuid],
            ),
            request = (actor) => ({
                pet_guid: actor.uuid,
                source_pet_guid: actor.source_guid,
                ...frozen.positions.selfSummon,
            })
        f.set(start + 600)
        const packets = f.call('KiboDuelArenaSummonReq', request(pet))
        assert.ok(packets.some((packet) => packet.id === 11811))
        assert.equal(f.run().pause.server_at, start)
        assert.equal(f.run().energy[1].points, 200)
        assert.deepEqual(f.run().energy[2], frozen.energy[2])
        assert.deepEqual(f.run().pet_sp, frozen.pet_sp)
        assert.deepEqual(f.run().scores, frozen.scores)
        assert.equal(f.run().end_at, frozen.end_at)
        assert.equal(f.run().gcd_until[1], start * 1000 + timing.gcd)
        assert.equal(f.run().in_fight[pet.uuid].entered_at, start)
        assert.equal(f.run().in_fight[pet.uuid].entered_report_at, start + 600)
        f.call('KiboDuelArenaSummonReq', request(pet))
        assert.equal(f.run().energy[1].points, 200, 'repeat ACK does not debit twice')
        const before = f.state()
        assert.throws(() => f.call('KiboDuelArenaSummonReq', request(next)), { code: ErrorCode.KiboDuelArenaGlobalCd })
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.tick(), [])
        f.set(start + 900)
        f.call('GamePause', { operate: false })
        assert.equal(f.run().gcd_until[1], (start + 900) * 1000 + timing.gcd)
        assert.equal(f.run().in_fight[pet.uuid].entered_at, start + 900)
        assert.equal(f.run().in_fight[pet.uuid].entered_report_at, start + 600)
        assert.equal(f.run().energy[1].points, 200)
        assert.throws(() => f.call('KiboDuelArenaSummonReq', request(next)), { code: ErrorCode.KiboDuelArenaGlobalCd })
        f.set(start + 900 + timing.gcd / 1000)
        f.call('KiboDuelArenaSummonReq', request(next))
        assert.ok(f.run().in_fight[next.uuid])
    } finally {
        f.close()
    }
})

test('guide pause does not waive action points, ownership or deployment bounds', () => {
    const f = fixture()
    try {
        f.call('GamePause', { operate: true })
        const run = f.run(),
            pet = Object.values(run.actors).find((actor) => actor.camp === 1 && !run.in_fight[actor.uuid]),
            request = { pet_guid: pet.uuid, source_pet_guid: pet.source_guid, ...run.positions.selfSummon }
        const before = f.state()
        assert.throws(() => f.call('KiboDuelArenaSummonReq', { ...request, source_pet_guid: '0' }), /source mismatch/)
        assert.throws(
            () => f.call('KiboDuelArenaSummonReq', { ...request, pos: { x: 0, y: 0, z: 0 } }),
            /deployment area/,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.energy[1].points = 99
        })
        f.set(f.now() + 600)
        const empty = f.state()
        assert.throws(() => f.call('KiboDuelArenaSummonReq', request), { code: ErrorCode.KiboDuelArenaPointNotEnough })
        assert.deepEqual(f.state(), empty, 'paused wall time cannot supply missing action points')
    } finally {
        f.close()
    }
})

test('a failed guide deployment packet rolls back cost and membership and can be retried while paused', () => {
    const f = fixture()
    try {
        f.call('GamePause', { operate: true })
        const run = f.run(),
            pet = Object.values(run.actors).find((actor) => actor.camp === 1 && !run.in_fight[actor.uuid]),
            request = { pet_guid: pet.uuid, source_pet_guid: pet.source_guid, ...run.positions.selfSummon },
            before = f.state(),
            original = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboInFightChange') throw Error('guide deployment packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('KiboDuelArenaSummonReq', request), /guide deployment packet fault/)
        f.game.packet = original
        assert.deepEqual(f.state(), before)
        f.call('KiboDuelArenaSummonReq', request)
        assert.ok(f.run().in_fight[pet.uuid])
        assert.equal(f.run().energy[1].points, run.energy[1].points - 100)
        assert.deepEqual(f.run().pause, run.pause)
    } finally {
        f.close()
    }
})

test('pause retries and stale toggles cannot reset the freeze origin or extend a resumed match twice', () => {
    const f = fixture()
    try {
        const start = f.now(),
            until = f.run().end_at
        f.call('GamePause', { operate: true, game_time: String(start * 1000) })
        f.set(start + 10)
        f.call('GamePause', { operate: true, game_time: String((start + 10) * 1000) })
        assert.equal(f.run().pause.server_at, start)
        const stale = f.call('GamePause', { operate: false, game_time: String(start * 1000 + 1) })
        assert.equal(stale.find((packet) => packet.id === 10786).data.operate, true)
        assert.equal(f.state().world.pause.operate, true)
        f.set(start + 30)
        f.call('GamePause', { operate: false, game_time: String((start + 30) * 1000) })
        assert.equal(f.run().end_at, until + 30)
        f.set(start + 31)
        f.call('GamePause', { operate: false, game_time: String((start + 30) * 1000) })
        assert.equal(f.run().end_at, until + 30)
        assert.equal(
            f.state().world.pause.updated_at,
            start + 30,
            'resume retries cannot discard an active recovery interval',
        )
        f.call('GamePause', { operate: true, game_time: String((start + 29) * 1000) })
        assert.equal(f.run().pause, undefined)
        f.call('GamePause', { operate: true })
        assert.ok(f.run().pause, 'optional absent client time does not prevent a real state change')
        f.set(start + 32)
        f.call('GamePause', { operate: false })
        assert.equal(f.run().pause, undefined)
        assert.equal(f.run().end_at, until + 31)
    } finally {
        f.close()
    }
})

test('a paused trainer stop excludes the pause interval and resume serialization faults roll back every shifted branch', () => {
    const f = fixture()
    try {
        const start = f.now(),
            trainer = f.run().trainer_guid
        f.call('SkillStart', {
            unit_id: trainer,
            skill: { skill_id: 19999903 },
            op_time: String(start * 1000),
            verify_info: { battle_index: '3', source_type: 1 },
        })
        f.call('GamePause', { operate: true, game_time: String(start * 1000 + 100) })
        const snapshot = f.state(),
            original = f.game.packet
        f.set(start + 20)
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboDuelArenaInfoSync') throw Error('resume packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(
            () => f.call('GamePause', { operate: false, game_time: String((start + 20) * 1000 + 100) }),
            /resume packet fault/,
        )
        f.game.packet = original
        assert.deepEqual(f.state(), snapshot)
        f.call('GamePause', { operate: false, game_time: String((start + 20) * 1000 + 100) })
        f.call('SkillStop', {
            unit_id: trainer,
            skill_id: '19999903',
            op_time: String((start + 20) * 1000 + 150),
            verify_info: { related_index: '3' },
        })
        assert.deepEqual(f.run().trainer_effects, [])
        assert.equal(f.run().trainer_skills[19999903].charges, 2)
    } finally {
        f.close()
    }
})

test('surrender during pause reports active time and does not strand the result/exit state machine', () => {
    const f = fixture()
    try {
        const start = f.now()
        f.call('GamePause', { operate: true, game_time: String(start * 1000) })
        f.set(start + 600)
        const result = f.call('KiboDuelSurrender').find((packet) => packet.id === 11806).data
        assert.equal(result.clearance_time, String(tables.find('kibo_duel', 501).time))
        assert.equal(f.run().pause, undefined)
        assert.equal(f.state().multiCampaign.arena_status, 5)
        f.set(f.run().exit_at)
        f.tick()
        assert.equal(f.state().multiCampaign.arena_status, 7)
    } finally {
        f.close()
    }
})

test('a stop received while still paused uses active cast time rather than the wall-clock pause duration', () => {
    const f = fixture()
    try {
        const start = f.now(),
            trainer = f.run().trainer_guid
        f.call('SkillStart', {
            unit_id: trainer,
            skill: { skill_id: 19999903 },
            op_time: String(start * 1000),
            verify_info: { battle_index: '5', source_type: 1 },
        })
        f.call('GamePause', { operate: true, game_time: String(start * 1000 + 100) })
        f.set(start + 20)
        f.call('SkillStop', {
            unit_id: trainer,
            skill_id: '19999903',
            op_time: String((start + 20) * 1000),
            verify_info: { related_index: '5' },
        })
        assert.deepEqual(f.run().trainer_effects, [])
        assert.ok(f.run().pause)
        assert.equal(f.run().trainer_skills[19999903].charges, 2)
    } finally {
        f.close()
    }
})

test('a terminal result already proven before the pause request is settled instead of frozen indefinitely', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.scores = { 1: 0, 2: 0 }
        })
        const packets = f.call('GamePause', { operate: true, game_time: String(f.now() * 1000) })
        assert.equal(packets.find((packet) => packet.id === 11806).data.result, 3)
        assert.equal(f.state().multiCampaign.arena_status, 5)
        assert.equal(f.run().pause, undefined)
    } finally {
        f.close()
    }
})

test('a loading-screen pause is adopted by FIRST and cannot silently consume its selection countdown', () => {
    const f = fixture(true)
    try {
        // Rebuild the actual ready transition, with the generic loading pause
        // already present when9602 changes START2 into FIRST3.
        f.store.transact(f.session.id, 0, (state) => {
            state.multiCampaign.arena_status = 2
            delete state.kiboDuelLoadingCompleteAt
            state.world.pause = { operate: true, game_time: String(f.now() * 1000), updated_at: f.now() }
        })
        f.call('MultiCampaignPlayerLoadFinish')
        assert.equal(f.state().multiCampaign.arena_status, 3)
        assert.ok(f.run().pause)
        const until = f.run().first_until
        f.set(f.now() + 100)
        assert.deepEqual(f.tick(), [])
        f.call('GamePause', { operate: false, game_time: String(f.now() * 1000) })
        assert.equal(f.run().first_until, until + 100)
    } finally {
        f.close()
    }
})

test('an entry UI pause freezes presentation and resumes its remaining time before starting the battle clock', () => {
    const f = fixture(true)
    try {
        f.call('KiboDuelArenaFirstConfirmReq')
        f.call('GamePause', { operate: true, game_time: String(f.now() * 1000) })
        const intro = f.run().intro_until
        assert.ok(f.run().pause)
        assert.equal(f.run().regular_started_at, undefined)
        f.set(f.now() + 30)
        assert.deepEqual(f.tick(), [])
        f.call('GamePause', { operate: false, game_time: String(f.now() * 1000) })
        assert.equal(f.run().pause, undefined)
        assert.equal(f.run().intro_until, intro + 30)
        f.set(intro + 30)
        f.tick()
        assert.equal(f.state().multiCampaign.arena_status, 4)
        assert.equal(f.run().regular_started_at, intro + 30)
        assert.equal(f.run().energy[1].points, arenaTiming(tables, 501).initial)
    } finally {
        f.close()
    }
})
