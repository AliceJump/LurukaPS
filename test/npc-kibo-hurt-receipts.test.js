import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaHurtIsDuplicate } from '../src/npc-kibo-hurt-receipts.js'

function receiptContext() {
    return {
        state: {
            world: { map_id: 1052 },
            multiCampaign: { arena_status: 4 },
            combat: {
                npcDuel: { map_id: 1052, actors: { 10: {}, 20: {} }, in_fight: { 10: {}, 20: {} } },
            },
        },
    }
}
const hurt = (index, extra = {}) => ({ from_id: '10', tar_id: '20', hp_change: -7, dmg_inc_id: index, ...extra })

test('client-global damage indices merge out-of-order ranges and distinguish hits sharing one element', () => {
    const c = receiptContext()
    for (const index of [1, 3, 2, 6, 4, 5]) assert.equal(arenaHurtIsDuplicate(c, hurt(index)), false)
    assert.deepEqual(c.state.combat.npcDuel.hurt_receipts.ranges, [[1, 6]])
    for (const index of [3, 1, 6]) assert.equal(arenaHurtIsDuplicate(c, hurt(index)), true)
    assert.equal(arenaHurtIsDuplicate(c, hurt(2147483647)), false)
    assert.equal(arenaHurtIsDuplicate(c, hurt(2147483646)), false)
    assert.equal(arenaHurtIsDuplicate(c, hurt(2147483647)), true)
    assert.equal(arenaHurtIsDuplicate(c, hurt(7, { element_uniqueId: '9007199254740993' })), false)
    assert.equal(arenaHurtIsDuplicate(c, hurt(8, { element_uniqueId: '9007199254740993' })), false)
    assert.throws(() => arenaHurtIsDuplicate(c, hurt(9, { dmg_inc_id: 2147483648 })), /Invalid arena damage index/)
})

test('old receipts remain idempotent after recent conflict diagnostics expire, with no newest-only watermark', () => {
    const c = receiptContext()
    for (let index = 1; index <= 600; index++) arenaHurtIsDuplicate(c, hurt(index))
    const receipt = c.state.combat.npcDuel.hurt_receipts
    assert.equal(receipt.order.length, 512)
    assert.equal(Object.keys(receipt.recent).length, 512)
    assert.equal(receipt.recent[1], undefined)
    assert.equal(arenaHurtIsDuplicate(c, hurt(1)), true)
    assert.equal(arenaHurtIsDuplicate(c, hurt(700)), false)
    assert.equal(arenaHurtIsDuplicate(c, hurt(650)), false, 'late first-seen IDs are not discarded as stale')
    const snapshot = structuredClone(c.state)
    assert.throws(() => arenaHurtIsDuplicate(c, hurt(600, { tar_id: '10' })), /Conflicting arena damage index/)
    assert.deepEqual(c.state, snapshot)
})

test('unsequenced, paused and non-fighting reports do not create receipts for unapplied HP', () => {
    const c = receiptContext(),
        run = c.state.combat.npcDuel
    assert.equal(arenaHurtIsDuplicate(c, hurt(0)), false)
    assert.equal(arenaHurtIsDuplicate(c, hurt(undefined)), false)
    run.pause = { server_at: 100 }
    assert.equal(arenaHurtIsDuplicate(c, hurt(1)), false)
    delete run.pause
    delete run.in_fight['20']
    assert.equal(arenaHurtIsDuplicate(c, hurt(1)), false)
    assert.equal(run.hurt_receipts, undefined)
    run.in_fight['20'] = {}
    assert.equal(arenaHurtIsDuplicate(c, hurt(1)), false)
    assert.equal(arenaHurtIsDuplicate(c, hurt(1)), true)
})

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    hurtAck = protocol.byName.get('SCProtoBattleInfoReduceNtf').id
function fixture() {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    const state = () => store.load(session.id).state
    const login = () => call('EnterGame', { open_id: 'npc-hurt-receipts' })
    login()
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
    const hit = (index, extra = {}) => ({
        from_id: '1',
        tar_id: '2',
        skill_id: 1,
        hp_change: -7,
        dmg_inc_id: index,
        ...extra,
    })
    const report = (...hits) =>
        call('BattleInfoReduce', {
            base_time: String(now * 1000),
            uint64_dic: [self.uuid, enemy.uuid],
            battle_info: hits.map((hurt_info) => ({ hurt_info })),
        })
    return {
        store,
        game,
        state,
        call,
        report,
        hit,
        self,
        enemy,
        get session() {
            return session
        },
        reconnect() {
            session = {}
            login()
            call('MultiCampaignPlayerLoaded')
            call('MultiCampaignPlayerLoadFinish')
        },
    }
}

test('repacked duplicate hurt rows apply HP and statistics once while each receives a current-HP ACK', () => {
    const f = fixture()
    try {
        const hp = f.state().combat.entities[f.enemy.uuid].hp
        assert.ok(hp > 50)
        const packets = f.report(f.hit(1), f.hit(1))
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, hp - 7)
        assert.equal(f.state().combat.npcDuel.statistics[f.self.uuid].damage, 7)
        const ack = packets.find((packet) => packet.id === hurtAck).data
        assert.equal(ack.battle_info.length, 2)
        assert.ok(ack.battle_info.every((row) => row.hurt_info.dmg_inc_id === 1 && row.hurt_info.cur_hp === hp - 7))
        f.report(f.hit(2))
        const retry = f.report(f.hit(1))
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, hp - 14)
        assert.equal(f.state().combat.npcDuel.statistics[f.self.uuid].damage, 14)
        assert.equal(retry.find((packet) => packet.id === hurtAck).data.battle_info[0].hurt_info.cur_hp, hp - 14)
        assert.ok(!retry.some((packet) => packet.id === 10009), 'retry does not publish a second HP transition')
        f.call('BattleInfoReduce', {
            base_time: '1800000000001',
            uint64_dic: [f.enemy.uuid, f.self.uuid],
            battle_info: [{ hurt_info: f.hit(1, { from_id: '2', tar_id: '1', skill_id: 2, cur_hp: hp - 100 }) }],
        })
        assert.equal(
            f.state().combat.entities[f.enemy.uuid].hp,
            hp - 14,
            'repacked dictionary and observational HP do not change event identity',
        )
    } finally {
        f.store.close()
    }
})

test('healing retries do not inflate HP/heal statistics and identical unsequenced hits remain distinct', () => {
    const f = fixture()
    try {
        const hp = f.state().combat.entities[f.enemy.uuid].hp
        f.report(f.hit(1), f.hit(2, { hp_change: 3 }), f.hit(2, { hp_change: 3 }))
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, hp - 4)
        assert.equal(f.state().combat.npcDuel.statistics[f.self.uuid].heal, 3)
        f.report(f.hit(0), f.hit(0))
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, hp - 18)
        assert.equal(f.state().combat.npcDuel.statistics[f.self.uuid].damage, 21)
        f.report(f.hit(2147483647), f.hit(3), f.hit(2147483647))
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, hp - 32)
    } finally {
        f.store.close()
    }
})

test('hurt receipts and HP roll back together on packet faults or conflicting reuse and avoid immediate SQLite writes', () => {
    const f = fixture()
    try {
        const writes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        const before = structuredClone(f.state()),
            original = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('hurt ACK packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.report(f.hit(1)), /hurt ACK packet fault/)
        f.game.packet = original
        assert.deepEqual(f.state(), before)
        f.report(f.hit(1))
        const applied = structuredClone(f.state())
        assert.throws(() => f.report(f.hit(2), f.hit(1, { hp_change: -8 })), /Conflicting arena damage index/)
        assert.deepEqual(f.state(), applied, 'earlier unique damage in a rejected packet cannot escape')
        f.report(f.hit(2))
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, before.combat.entities[f.enemy.uuid].hp - 14)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
    } finally {
        f.store.close()
    }
})

test('entity rebuild starts a new client counter generation and terminal persistence strips temporary receipts', () => {
    const f = fixture()
    try {
        f.report(f.hit(1))
        const hp = f.state().combat.entities[f.enemy.uuid].hp
        const epoch = f.state().combat.npcDuel.origin_epoch
        f.reconnect()
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, hp)
        assert.ok(f.state().combat.npcDuel.origin_epoch > epoch)
        assert.equal(f.state().combat.npcDuel.hurt_receipts, undefined)
        f.report(f.hit(1))
        assert.equal(f.state().combat.entities[f.enemy.uuid].hp, hp - 7)
        const before = structuredClone(f.state()),
            original = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('receipt result packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('KiboDuelSurrender'), /receipt result packet fault/)
        f.game.packet = original
        assert.deepEqual(f.state(), before)
        f.call('KiboDuelSurrender')
        assert.equal(f.state().combat.npcDuel.hurt_receipts, undefined)
        const saved = JSON.parse(
            f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state,
        )
        assert.equal(saved.combat.npcDuel.hurt_receipts, undefined)
    } finally {
        f.store.close()
    }
})
