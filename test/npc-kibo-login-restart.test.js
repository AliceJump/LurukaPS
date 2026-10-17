import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaTiming } from '../src/npc-kibo-clock.js'
import { arenaSpConfig } from '../src/npc-kibo-sp.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

function fixture(duelId = 501) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        gameTables = new Tables(cfg.tables),
        game = new Game(p, store, gameTables, { clock: () => now })
    const state = () => store.load(session.id).state
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
            .map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'login-restart' })
    }
    login()
    call('KiboDuelGetGroup', { u32: duelId })
    const home = structuredClone(state().world),
        history = structuredClone(state().worldHistory)
    call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', duelId).dungeonId })
    const ready = () => {
        call('MultiCampaignPlayerLoaded')
        return call('MultiCampaignPlayerLoadFinish')
    }
    const battle = () => {
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
    }
    return {
        store,
        tables: gameTables,
        game,
        call,
        login,
        enter: () => call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', duelId).dungeonId }),
        ready,
        battle,
        state,
        home,
        history,
        run: () => state().combat.npcDuel,
        advance: (seconds) => {
            now += seconds
        },
        get id() {
            return session.id
        },
    }
}

for (const phase of [2, 3, 6, 4]) {
    test(`unfinished NPC login starts over from phase ${phase}, discards old runtime and preserves durable progress/return location`, () => {
        const f = fixture()
        try {
            if (phase !== 2) f.ready()
            if (phase === 6) f.call('KiboDuelArenaFirstConfirmReq')
            if (phase === 4) f.battle()
            f.call('GamePause', { operate: true })
            f.store.transact(f.id, 0, (s) => {
                const r = s.combat.npcDuel,
                    first = Object.keys(r.actors)[0]
                s.combat.entities[first].hp = 0
                r.statistics = { [first]: { damage: 123 } }
                r.dead[first] = 1
                r.ai_control = { 0: 1 }
                r.trainer_skills = { 19999903: { charges: 0, ready_at: 9999999999999 } }
                r.stage_buffs_sent = { stale: true }
                s.combat.elements.old = { fixture: true }
                s.kiboDuelRecords = { 1001: { id: 1001, success_time: 1700000000 } }
            })
            const before = f.state(),
                old = f.run()
            f.advance(600)
            const returned = f.login()
            assert.ok(
                !returned.some((x) => x.id === 11800),
                'cold login uses the normal world, not a half-initialized arena UI',
            )
            assert.equal(f.state().multiCampaign, undefined)
            assert.equal(f.state().combat, undefined)
            assert.equal(f.state().world.pause, undefined)
            assert.equal(f.state().world.map_id, f.home.map_id)
            assert.deepEqual(f.state().world.pos, f.home.pos)
            assert.equal(f.state().worldHistory?.length ?? 0, (before.worldHistory?.length ?? 0) - 1)
            const packets = f.enter(),
                fresh = f.run()
            assert.equal(packets.find((x) => x.id === 11800).data.status, 2)
            assert.equal(f.state().multiCampaign.arena_status, 2)
            assert.equal(f.state().multiCampaign.formation_slot, before.multiCampaign.formation_slot)
            assert.equal(fresh.generation, old.generation + 1)
            assert.ok(Object.keys(fresh.actors).every((id) => !old.actors[id]))
            assert.ok(Object.keys(old.actors).every((id) => f.state().retiredNpcArenaActors[id]))
            assert.equal(fresh.pause, undefined)
            assert.equal(f.state().world.pause, undefined)
            assert.equal(f.state().kiboDuelLoadingCompleteAt, undefined)
            assert.equal(f.state().kiboDuelFirstConfirmedAt, undefined)
            for (const key of [
                'energy',
                'statistics',
                'trainer_skills',
                'ai_control',
                'stage_buffs_sent',
                'controls',
                'regular_started_at',
            ])
                assert.equal(fresh[key], undefined, key)
            assert.deepEqual(fresh.in_fight, {})
            assert.deepEqual(fresh.dead, {})
            assert.deepEqual(f.state().combat.elements, {})
            assert.deepEqual(f.state().world.pos, fresh.positions.self.pos)
            assert.deepEqual(f.state().worldHistory, before.worldHistory)
            assert.deepEqual(f.state().kiboDuelRecords, before.kiboDuelRecords)
            assert.deepEqual(f.state().kiboDuelGroups, before.kiboDuelGroups)
            for (const actor of Object.values(fresh.actors)) {
                assert.equal(f.state().combat.entities[actor.uuid].hp, actor.max_hp)
                assert.equal(f.state().combat.entities[actor.uuid].sp, arenaSpConfig(tables, actor.config_id).initial)
            }
            const ready = f.ready()
            assert.equal(ready.find((x) => x.id === 11800).data.status, 3)
            const generation = f.run().generation
            f.call('MultiCampaignPlayerLoaded')
            f.call('MultiCampaignPlayerLoadFinish')
            assert.equal(f.run().generation, generation, 'same-connection callbacks do not restart again')
            f.battle()
            assert.equal(f.state().multiCampaign.arena_status, 4)
            assert.equal(f.run().energy[1].points, arenaTiming(tables, 501).initial)
            f.call('MultiCampaignQuit')
            assert.equal(f.state().world.map_id, f.home.map_id)
            assert.deepEqual(f.state().world.pos, f.home.pos)
        } finally {
            f.store.close()
        }
    })
}

test('new NPC interaction uses a new generation even within the same second; invalid entry config rolls back', () => {
    const f = fixture(502)
    try {
        f.ready()
        f.battle()
        f.call('GamePause', { operate: true })
        const old = f.run(),
            owned = f.state().player.heros_info.heros
        f.login()
        assert.equal(f.state().multiCampaign, undefined)
        const before = f.state(),
            original = f.tables.get('game')
        f.tables.cache.set(
            'game',
            original.map((row) =>
                row.title === 'KIBO_DUEL_ARENA_MODE_SCORE_START' ? { ...row, value: 'invalid' } : row,
            ),
        )
        assert.throws(f.enter, /Arena score configuration unavailable/)
        f.tables.cache.set('game', original)
        assert.deepEqual(f.state(), before)
        f.enter()
        assert.equal(f.run().generation, old.generation + 1)
        assert.equal(f.run().trainer_guid, old.trainer_guid)
        assert.deepEqual(f.state().player.heros_info.heros, owned)
        const first = f.run()
        f.login()
        f.enter()
        assert.equal(f.run().generation, first.generation + 1)
        assert.equal(f.run().start_time, first.start_time)
        f.ready()
        assert.equal(f.state().multiCampaign.arena_status, 3)
    } finally {
        f.store.close()
    }
})
