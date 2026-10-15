import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const login = () => {
        const e = p.byName.get('CSProtoEnterGame')
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, { open_id: 'duel-progress-login' }) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    login()
    return {
        store,
        game,
        login,
        state: () => store.load(session.id).state,
        get id() {
            return session.id
        },
        get session() {
            return session
        },
        newSession() {
            session = {}
        },
    }
}

test('fresh login restores saved NPC clear markers before task/UI initialization without requesting an NPC group', () => {
    const f = fixture()
    try {
        f.store.transact(f.id, 0, (s) => {
            s.kiboDuelRecords = {
                1001: { id: 1001, star: 0, success_time: '1791989468' },
                1002: { id: 1002, star: 0, success_time: '1791995843' },
            }
            s.kiboDuelSlot = 3
            s.kiboDuelGroups = {
                3: {
                    slot: 3,
                    duel_id: 1001,
                    hero: s.player.heros_info.heros[0].guid,
                    pet_guids: s.pets.slice(0, 8).map((pet) => ({ id: pet.guid, guid: pet.guid, is_trial: false })),
                    hero_skills: [],
                    index: 0,
                },
            }
        })
        const before = structuredClone(f.state())
        f.newSession()
        const packets = f.login(),
            updates = packets.filter((packet) => packet.id === 10740)
        assert.equal(updates.length, 1)
        const data = updates[0].data
        assert.deepEqual(data.records, [
            { id: 1001, star: 0, success_time: '1791989468' },
            { id: 1002, star: 0, success_time: '1791995843' },
        ])
        assert.equal(data.use_slot, 3)
        assert.equal(data.groups[0].slot, 3)
        assert.equal(data.groups[0].pet_guids.length, 8)
        assert.ok(
            packets.findIndex((packet) => packet.id === 6505) < packets.findIndex((packet) => packet.id === 10740),
            'pet profiles precede saved formation data',
        )
        const tasksId = p.byName.get('CSProtoTaskSync').id
        assert.ok(
            packets.findIndex((packet) => packet.id === 10740) < packets.findIndex((packet) => packet.id === tasksId),
        )
        assert.deepEqual(f.state().kiboDuelRecords, before.kiboDuelRecords)
        assert.deepEqual(
            f.state().player.sbag_infos,
            before.player.sbag_infos,
            'synchronizing progress grants no rewards',
        )
        assert.equal(f.state().multiCampaign, undefined, 'restoring clear markers does not enter a duel')
        assert.equal(
            data.records.some((record) => record.id === 1003),
            false,
            'unbeaten levels stay absent',
        )
    } finally {
        f.store.close()
    }
})

test('empty progress is explicit and a failed login progress packet rolls back before a clean retry', () => {
    const f = fixture()
    try {
        const before = structuredClone(f.state()),
            original = f.game.packet
        f.newSession()
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoKiboDuelGroupInfoSync') throw Error('duel progress packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.login(), /duel progress packet fault/)
        assert.notEqual(f.session.entered, true)
        assert.deepEqual(f.state(), before)
        f.game.packet = original
        const update = f.login().find((packet) => packet.id === 10740).data
        assert.deepEqual(update.records, [])
        assert.deepEqual(update.groups, [])
        assert.equal(update.use_slot, 1)
        assert.ok(update.area_infos.length > 0)
    } finally {
        f.store.close()
    }
})
