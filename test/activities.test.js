import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { configTime } from '../src/shops.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
function setup() {
    const store = new Store(':memory:'),
        session = {}
    let now = Date.UTC(2026, 9, 11, 4) / 1000,
        seq = 1
    const game = new Game(p, store, tables, { clock: () => now })
    const call = (name, request = {}, s = session) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(s, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, request) })
    }
    call('EnterGame', { open_id: 'activity-tests' })
    const mutate = (fn) => store.transact(session.id, 0, fn)
    const state = () => store.load(session.id).state
    const decode = (packets, name) => {
        const e = p.byName.get(name)
        return p.decode(e.rsp, packets.find((x) => x.id === e.id).payload)
    }
    return {
        store,
        session,
        game,
        call,
        mutate,
        state,
        decode,
        advance: (days) => {
            now += days * 86400
        },
    }
}
function unlock(state) {
    ;(state.taskRecords ??= []).push(...[106010, 106013].map((task_id) => ({ task_id, count: 1 })))
}
test('CBT3 activity and common time windows agree; expired events extend through 2030 and locked claims remain locked', () => {
    const f = setup()
    try {
        const packets = f.call('ActivityGet')
        const activity = f.decode(packets, 'CSProtoActivityGet').confs.find((x) => x.activity_id === 2001)
        assert.equal(activity.start_time, 0) // current 998003 is a server-controlled time ID, absent from the fixed-date table.
        assert.equal(activity.end_time, configTime('20301231-235959'))
        const time = f.decode(packets, 'CSProtoSyncCommonTimeConf').data_list.find((x) => x.time_id === 998003)
        assert.equal(Number(time.end_time), activity.end_time)
        const before = f.state().player.sbag_infos
        assert.throws(() => f.call('ActivityDailySign', { u32: 2001 }), /locked/)
        assert.deepEqual(f.state().player.sbag_infos, before)
        // A missing timelimit is an explicitly documented offline fallback, not a made-up duration.
        assert.equal(
            f.decode(packets, 'CSProtoActivityGet').confs.find((x) => x.activity_id === 4001).end_time,
            configTime('20301231-235959'),
        )
    } finally {
        f.store.close()
    }
})
test('current client getIdByType can find the attendance page using its own time ID; every activity has a matching public window', () => {
    const f = setup()
    try {
        f.mutate(unlock)
        const packets = f.call('EnterGame', { open_id: 'activity-tests' }, {})
        const snapshot = f.decode(packets, 'CSProtoActivitySync')
        const windows = f.decode(packets, 'CSProtoSyncCommonTimeConf').data_list
        const now = Date.UTC(2026, 9, 11, 4) / 1000
        const currentRows = f.game.activities.rows
        assert.equal(currentRows.find((x) => x.id === 2001).timelimit, 998003)
        const candidates = currentRows
            .filter((row) => row.type === 3 && f.game.activities.unlocked(row, f.state()))
            .filter((row) => {
                const time = windows.find((x) => x.time_id === row.timelimit)
                return time && Number(time.start_time) <= now && Number(time.end_time) >= now
            })
        assert.deepEqual(
            candidates.map((x) => x.id),
            [2001],
        )
        assert.ok(snapshot.activitys.find((x) => x.id === 2001)?.data.daily_sign)
        for (const row of currentRows) {
            const time = windows.find((x) => x.time_id === row.timelimit)
            const conf = snapshot.confs.find((x) => x.activity_id === row.id)
            assert.ok(time, `missing client time ID ${row.timelimit}`)
            assert.equal(Number(time.start_time), conf.start_time)
            assert.equal(Number(time.end_time), conf.end_time)
        }
    } finally {
        f.store.close()
    }
})
test('activity guide is accepted once from its table; verified guide dungeon return repairs the configured scene without completing the task', () => {
    const f = setup()
    try {
        f.mutate(unlock)
        f.call('EnterGame', { open_id: 'activity-tests' }, {})
        assert.equal(f.state().tasks.filter((x) => x.task_id === 404002).length, 1)
        assert.equal(f.state().tasks.find((x) => x.task_id === 404002).nodes[0].node_id, 5)
        f.call('EnterGame', { open_id: 'activity-tests' }, {})
        assert.equal(f.state().tasks.filter((x) => x.task_id === 404002).length, 1)
        f.mutate((s) => {
            const task = s.tasks.find((x) => x.task_id === 404002)
            task.nodes = [{ node_id: 3, node_values: [0], client_before: true, client_cond_after: [false] }]
            task.finish_nodes = [2, 5]
            s.world.map_id = 100
            s.storyCampaignClears = { 905: { count: 1, time: 1 } } // no authoritative task proof
        })
        f.call('EnterGame', { open_id: 'activity-tests' }, {})
        assert.equal(f.state().world.map_id, 100)
        f.mutate((s) => {
            s.storyCampaignClears[905].task_proof = { victory_task_id: 404001, task_ids: [404001] }
        })
        const login = f.call('EnterGame', { open_id: 'activity-tests' }, {})
        assert.equal(f.state().world.map_id, 200)
        assert.equal(f.state().world.point_id, 20005)
        assert.equal(f.state().tasks.find((x) => x.task_id === 404002).nodes[0].node_id, 3)
        assert.ok(!f.state().taskRecords.some((x) => x.task_id === 404002))
        assert.ok(f.decode(login, 'CSProtoTaskSync').tasks.some((x) => x.task_id === 404002))
        // Let the existing configured client callbacks acknowledge return and page action.
        const r = { task_id: 404002, node_id: 3 }
        f.call('TaskClientBefore', r)
        f.call('TaskClientCondAfter', { ...r, indexes: [0] })
        f.call('TaskClientAfter', r)
        f.call('TaskFinish', { u32: 404002 })
        assert.ok(f.state().taskRecords.some((x) => x.task_id === 404002 && x.count === 1))
        f.call('EnterGame', { open_id: 'activity-tests' }, {})
        assert.ok(!f.state().tasks.some((x) => x.task_id === 404002))
    } finally {
        f.store.close()
    }
})
test('attendance grants real inventory once per login day; skipped calendar days and reconnect do not duplicate rewards', () => {
    const f = setup()
    try {
        f.mutate(unlock)
        f.call('ActivityGet')
        const before = f
            .state()
            .player.sbag_infos.items.filter((x) => x.itemid === 501000)
            .reduce((n, x) => n + x.itemnum, 0)
        const first = f.call('ActivityDailySign', { u32: 2001 })
        assert.equal(f.decode(first, 'CSProtoActivityDailySign').src, 96)
        assert.equal(
            f
                .state()
                .player.sbag_infos.items.filter((x) => x.itemid === 501000)
                .reduce((n, x) => n + x.itemnum, 0),
            before + 1,
        )
        assert.deepEqual(f.decode(f.call('ActivityDailySign', { u32: 2001 }), 'CSProtoActivityDailySign').rewards, [])
        f.call('EnterGame', { open_id: 'activity-tests' }, {})
        assert.equal(f.state().activities[2001].sign.count, 1)
        f.advance(3)
        f.call('ActivityGet')
        assert.equal(f.state().activities[2001].sign.count, 2)
        assert.equal(
            f.decode(f.call('ActivityDailySign', { u32: 2001 }), 'CSProtoActivityDailySign').rewards[0].itemnum,
            2,
        )
        f.mutate((s) => {
            s.player.heros_info.heros = s.player.heros_info.heros.filter((x) => x.conf_id !== 199003)
        })
        f.advance(1)
        const heroPackets = f.call('ActivityDailySign', { u32: 2001 })
        const acquired = f.decode(heroPackets, 'CSProtoActivityDailySign').rewards.find((x) => x.itemtype === 1)
        assert.equal(acquired.itemid, 199003)
        assert.ok(
            heroPackets
                .slice(
                    0,
                    heroPackets.findIndex((x) => x.id === 10403),
                )
                .some(
                    (x) =>
                        x.id === p.byName.get('CSProtoSyncPlayerData').id &&
                        p.decode('cs.PlayerData', x.payload)?.heros_info?.heros?.some((h) => h.guid === acquired.guid),
                ),
        )
    } finally {
        f.store.close()
    }
})
test('seven-day production and catch variety count actual server records, not seeded inventory; day tick runs once', () => {
    const f = setup()
    try {
        f.mutate((s) => {
            unlock(s)
            s.home.craftCounts = { 501002: 10 }
            s.petCaptureResults = Object.fromEntries(
                tables
                    .get('pet')
                    .filter((x) => x.IsCatch === 1)
                    .slice(0, 5)
                    .map((x, i) => [i, { pet_id: x.id }]),
            )
        })
        const snapshot = f.decode(f.call('ActivityGet'), 'SCProtoNDayInfoSync')
        assert.equal(snapshot.target_infos.find((x) => x.id === 10104).progress, 10)
        assert.equal(snapshot.target_infos.find((x) => x.id === 10104).state, 1)
        assert.equal(snapshot.target_infos.find((x) => x.id === 10103).state, 1)
        f.advance(1)
        const packets = f.game.tickRaw(f.session.id)
        assert.equal(f.decode(packets, 'SCProtoNDayInfoSync').unlock_day, 2)
        assert.equal(f.state().activities[2001].sign.count, 2)
        assert.deepEqual(f.game.tickRaw(f.session.id), [])
    } finally {
        f.store.close()
    }
})
test('level/main activity rewards use actual drop pools and receipts; mixed invalid selections roll back every reward', () => {
    const f = setup()
    try {
        f.mutate((s) => {
            unlock(s)
            s.player.basic_info.lv = 10
        })
        const before = f.state().player.sbag_infos
        assert.throws(
            () => f.call('ActivityReward', { activity_id: 4001, reward_id_list: [40010101, 30010101] }),
            /belong/,
        )
        assert.deepEqual(f.state().player.sbag_infos, before)
        const packets = f.call('ActivityReward', { activity_id: 4001, reward_id_list: [40010101, 40010101] })
        const reply = f.decode(packets, 'CSProtoActivityReward')
        assert.ok(reply.rewards.length)
        assert.equal(reply.src, 111)
        assert.deepEqual(f.state().activities[4001].claims, [40010101])
        assert.equal(
            f
                .decode(packets, 'CSProtoActivitySync')
                .activitys.find((x) => x.id === 4001)
                .rewards.find((x) => x.id === 40010101).state,
            2,
        )
        assert.deepEqual(
            f.decode(
                f.call('ActivityReward', { activity_id: 4001, reward_id_list: [40010101] }),
                'CSProtoActivityReward',
            ).rewards,
            [],
        )
        assert.throws(() => f.call('ActivityReward', { activity_id: 4001, reward_id_list: [40010102] }), /not complete/)
        assert.ok(
            f.decode(
                f.call('ActivityReward', { activity_id: 3001, reward_id_list: [30010101] }),
                'CSProtoActivityReward',
            ).rewards.length,
        )
    } finally {
        f.store.close()
    }
})
test('seven-day requests claim a DAY, preserve completed targets and reject locked days and unearned totals', () => {
    const f = setup()
    try {
        f.mutate(unlock)
        const sync = f.decode(f.call('ActivityGet'), 'SCProtoNDayInfoSync')
        assert.equal(sync.unlock_day, 1)
        assert.equal(sync.target_infos.find((x) => x.id === 10102).state, 1)
        assert.equal(sync.target_infos.find((x) => x.id === 10101).state, 0)
        assert.equal(sync.target_infos.find((x) => x.id === 10105).state, 0) // don't fake unimplemented duel wins
        assert.throws(() => f.call('GetNDayReward', { reward_type: 0, reward_param: 2 }), /locked/)
        const packet = f.call('GetNDayReward', { reward_type: 0, reward_param: 1 })
        assert.ok(f.decode(packet, 'CSProtoGetNDayReward').rewards.some((x) => x.itemid === 1520002))
        assert.equal(f.decode(packet, 'SCProtoNDayInfoSync').target_infos.find((x) => x.id === 10102).state, 2)
        assert.deepEqual(
            f.decode(f.call('GetNDayReward', { reward_type: 0, reward_param: 1 }), 'CSProtoGetNDayReward').rewards,
            [],
        )
        assert.throws(() => f.call('GetNDayReward', { reward_type: 1, reward_param: 1 }), /not reached/)
        f.advance(1)
        assert.equal(f.decode(f.call('ActivityGet'), 'SCProtoNDayInfoSync').unlock_day, 2)
    } finally {
        f.store.close()
    }
})
