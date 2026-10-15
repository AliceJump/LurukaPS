import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { startServer } from '../src/server.js'
import { FrameReader, encodeFrame } from '../src/wire.js'
import { ARENA_TIMER_MS, arenaMillis } from '../src/npc-kibo-time.js'
import { arenaSpConfig } from '../src/npc-kibo-sp.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture() {
    let ms = 1800000000123,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => Math.floor(ms / 1000), arenaClockMs: () => ms }),
        session = {}
    const state = () => store.load(session.id).state
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
        game.trackArenaTick(session, e.id, packets)
        return packets.map((packet) => ({
            id: packet.id,
            data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        }))
    }
    call('EnterGame', { open_id: 'arena-ms' })
    call('KiboDuelGetGroup', { u32: 501 })
    call('MultiCampaignCreate', { dungeon_id: 40007 })
    call('MultiCampaignPlayerLoaded')
    call('MultiCampaignPlayerLoadFinish')
    call('KiboDuelArenaFirstConfirmReq')
    ms = Math.round(state().combat.npcDuel.intro_until * 1000)
    game.tickArena(session.id, session)
    call('ControlMapAI', { control_type: 0, status: 1 })
    return {
        store,
        game,
        session,
        state,
        call,
        get ms() {
            return ms
        },
        set ms(value) {
            ms = value
        },
        tick: () =>
            game.tickArena(session.id, session).map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            })),
    }
}

test('same-second frame16 and passive SP use the separate millisecond clock while ping/legacy timestamps remain integer seconds', () => {
    const f = fixture()
    try {
        const run = f.state().combat.npcDuel,
            start = f.ms,
            whole = f.game.clock(),
            trainer = run.trainer_guid
        const actor = Object.values(run.actors).find((actor) => actor.camp === 1 && run.in_fight[actor.uuid])
        const points = run.energy[1].points,
            sp = f.state().combat.entities[actor.uuid].sp
        f.call('SkillStart', {
            unit_id: trainer,
            skill: { skill_id: 19999903 },
            op_time: String(start),
            verify_info: { battle_index: '900', source_type: 1 },
        })
        assert.equal(f.state().combat.npcDuel.trainer_effects[0].at_ms, start + 16000 / 60)
        f.ms = start + 250
        f.tick()
        assert.ok(f.state().combat.npcDuel.energy[1].points < points + 100)
        f.ms = start + 267
        f.tick()
        assert.equal(f.game.clock(), whole)
        assert.ok(f.state().combat.npcDuel.energy[1].points >= points + 200)
        f.ms = start + 500
        f.tick()
        assert.equal(f.state().combat.entities[actor.uuid].sp, sp + 9, 'five MyFloat0.1 steps retain their fraction')
        const ping = f.call('Ping', { client_ts: '77' }).find((packet) => packet.id === 503).data
        assert.equal(ping.time, f.game.clock())
        assert.equal(Number.isInteger(ping.time), true)
        assert.equal(arenaMillis({ now: 100.125 }), 100125)
    } finally {
        f.store.close()
    }
})

test('subsecond pause shifts deadlines and fractional resume/settlement values encode as valid integer protocol fields', () => {
    const f = fixture()
    try {
        const start = f.ms,
            id = Object.values(f.state().combat.npcDuel.actors).find((actor) => actor.camp === 1).uuid
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.pet_ai[id] = {
                moving: false,
                ready_at: start + 1000,
                cooldowns: {},
                groups: {},
                gcd_until: 0,
            }
        })
        f.ms = start + 100
        f.call('GamePause', { operate: true, game_time: String(f.ms) })
        f.tick()
        assert.equal(f.session.npcArenaTick, false)
        f.ms += 200
        const resumed = f.call('GamePause', { operate: false, game_time: String(f.ms) })
        assert.equal(f.state().combat.npcDuel.pet_ai[id].ready_at, start + 1200)
        assert.equal(f.session.npcArenaTick, true)
        assert.match(resumed.find((packet) => packet.id === 11800).data.status_endtime, /^\d+$/)
        f.ms += 79
        const packets = f.call('KiboDuelSurrender')
        assert.match(packets.find((packet) => packet.id === 11806).data.clearance_time, /^\d+$/)
        const result = f.state().combat.npcDuel
        f.ms = Math.round(result.exit_at * 1000) - 1
        assert.equal(
            f.tick().some((packet) => packet.id === 11800 && packet.data.status === 7),
            false,
        )
        f.ms++
        assert.ok(f.tick().some((packet) => packet.id === 11800 && packet.data.status === 7))
        assert.equal(f.session.npcArenaTick, false)
    } finally {
        f.store.close()
    }
})

test('fine updates retain pressure fractions so repeated sub-point intervals lose the same25 points as one whole second', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            const run = state.combat.npcDuel
            run.in_fight = Object.fromEntries(Object.entries(run.in_fight).filter(([id]) => run.actors[id].camp === 1))
        })
        const start = f.ms,
            score = f.state().combat.npcDuel.scores[2]
        for (let delta = 20; delta <= 1000; delta += 20) {
            f.ms = start + delta
            f.tick()
        }
        assert.equal(f.state().combat.npcDuel.scores[2], score - 25)
        assert.equal(f.state().combat.npcDuel.score_remainders[2], 0)
    } finally {
        f.store.close()
    }
})

test('arena ticks borrow pending state, use small drafts, deduplicate unchanged output and roll back packet failures without SQLite writes', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            const run = state.combat.npcDuel
            for (const actor of Object.values(run.actors)) {
                const max = arenaSpConfig(tables, actor.config_id).max
                state.combat.entities[actor.uuid].sp = max
                ;(run.pet_sp ??= {})[actor.uuid] = { milli: max * 1000, at: f.ms, lock_until: 0 }
            }
            run.energy[1].points = 3000
            run.energy[2].points = 3000
        })
        f.ms += 20
        f.tick()
        const writes = f.store.db.prepare('SELECT total_changes() AS n').get().n,
            originalLoad = f.store.load
        f.store.load = () => {
            throw Error('large state clone is forbidden')
        }
        f.ms += 1
        assert.deepEqual(f.tick(), [])
        f.ms += 20
        assert.deepEqual(f.tick(), [])
        f.store.load = originalLoad
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.hand_sent = undefined
        })
        const before = f.state(),
            packet = f.game.packet
        f.ms += 20
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboDuelArenaCardInfoSync') throw Error('fine tick packet fault')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.tick(), /fine tick packet fault/)
        f.game.packet = packet
        assert.deepEqual(f.state(), before)
        f.tick()
    } finally {
        f.store.close()
    }
})

test('inactive/loading/pause hints stop fine polling until a confirmed arena status or load callback wakes it', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.entities_sent = false
        })
        assert.deepEqual(f.tick(), [])
        assert.equal(f.session.npcArenaTick, false)
        f.game.trackArenaTick(f.session, 9602, [])
        assert.equal(f.session.npcArenaTick, true)
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.entities_sent = true
            delete state.kiboDuelLoadingCompleteAt
        })
        assert.deepEqual(f.tick(), [])
        assert.equal(f.session.npcArenaTick, false, 'publishing entities alone is not the client readiness callback')
        f.store.transact(f.session.id, 0, (state) => {
            state.world.map_id = 100
        })
        assert.deepEqual(f.tick(), [])
        assert.equal(f.session.npcArenaTick, false)
    } finally {
        f.store.close()
    }
})

test('selection/movie waits use an exact wake deadline instead of repeatedly reading cold state, and status changes invalidate the hint', () => {
    const f = fixture(),
        originalRead = f.store.read
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.multiCampaign.arena_status = 6
            state.combat.npcDuel.intro_until = (f.ms + 10000) / 1000
        })
        f.game.trackArenaTick(f.session, 0, [f.game.packet('SCProtoKiboDuelArenaInfoSync', { status: 6 })])
        f.tick()
        assert.equal(f.session.npcArenaWakeMs, f.ms + 10000)
        f.store.read = () => {
            throw Error('cold state should remain asleep')
        }
        for (let i = 0; i < 20; i++) {
            f.ms += 16
            assert.deepEqual(f.tick(), [])
        }
        f.store.read = originalRead
        f.game.trackArenaTick(f.session, 9602, [])
        assert.equal(f.session.npcArenaWakeMs, 0)
        f.tick()
        assert.ok(f.session.npcArenaWakeMs > f.ms)
    } finally {
        f.store.read = originalRead
        f.store.close()
    }
})

test('real TCP arena scheduler executes the frame effect without the one-second production loop', async () => {
    const logs = [],
        server = await startServer(
            { ...cfg, gamePort: 0, httpPort: 0, database: ':memory:' },
            { warn: (message) => logs.push(message) },
        )
    let ms = 1800000000123,
        seq = 100
    server.game.clock = () => Math.floor(ms / 1000)
    server.game.arenaClockMs = () => ms
    server.game.tick = () => [] // The fine timer must do all arena scheduling.
    const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
        reader = new FrameReader(),
        queue = []
    socket.on('data', (chunk) => queue.push(...reader.feed(chunk)))
    const wait = async (predicate) => {
        const until = Date.now() + 3000
        while (Date.now() < until) {
            if (predicate()) return
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw Error('TCP fine arena update timed out: ' + logs.join('; '))
    }
    const send = (name, data = {}) => {
        const e = server.protocol.byName.get('CSProto' + name)
        socket.write(encodeFrame({ id: e.id, seq: seq++ }, server.protocol.encode(e.req, data)))
    }
    try {
        assert.ok(ARENA_TIMER_MS <= 17)
        await once(socket, 'connect')
        send('EnterGame', { open_id: 'tcp-arena-ms' })
        await wait(() => queue.some((frame) => frame.id === 5001))
        const id = server.protocol.decode(
            server.protocol.byId.get(5001).rsp,
            queue.find((frame) => frame.id === 5001).payload,
        ).player_id
        const state = () => server.store.load(id).state
        send('KiboDuelGetGroup', { u32: 501 })
        send('MultiCampaignCreate', { dungeon_id: 40007 })
        send('MultiCampaignPlayerLoaded')
        send('MultiCampaignPlayerLoadFinish')
        send('KiboDuelArenaFirstConfirmReq')
        await wait(() => state().multiCampaign?.arena_status === 6)
        ms = Math.round(state().combat.npcDuel.intro_until * 1000)
        await wait(() => state().multiCampaign?.arena_status === 4)
        send('ControlMapAI', { control_type: 0, status: 1 })
        await wait(() => state().combat.npcDuel.ai_control?.[0] === 1)
        const start = ms,
            whole = Math.floor(ms / 1000),
            points = state().combat.npcDuel.energy[1].points
        send('SkillStart', {
            unit_id: state().combat.npcDuel.trainer_guid,
            skill: { skill_id: 19999903 },
            op_time: String(ms),
            verify_info: { battle_index: '900' },
        })
        await wait(() => state().combat.npcDuel.trainer_cast_serial > 0)
        ms = start + 250
        await wait(() => state().combat.npcDuel.energy[1].at >= ms / 1000)
        assert.ok(state().combat.npcDuel.energy[1].points < points + 100)
        ms = start + 267
        await wait(() => state().combat.npcDuel.energy[1].points >= points + 200)
        assert.equal(Math.floor(ms / 1000), whole)
        assert.equal(
            logs.some((message) => message.includes('Arena update:')),
            false,
        )
    } finally {
        socket.destroy()
        await server.close()
    }
})
