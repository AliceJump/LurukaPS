import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { i64, u64, expandBattleReport } from '../src/combat-state.js'
import {
    recordArenaSkillOrigin,
    recordArenaBulletOrigin,
    recordArenaElementOrigin,
    arenaElementOrigin,
} from '../src/npc-kibo-origins.js'
import { npcArenaStatistics } from '../src/npc-kibo-statistics.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
const captured = JSON.parse(
    fs.readFileSync(new URL('./fixtures/npc-arena-signed-origin.json', import.meta.url), 'utf8'),
)

test('BattleVerifyInfo keeps signed int64 provenance exact without relaxing unsigned actor/sequence fields', () => {
    assert.equal(p.type('BattleVerifyInfo').fields.source_id.type, 'int64')
    for (const field of ['battle_index', 'related_index', 'op_time'])
        assert.equal(p.type('BattleVerifyInfo').fields[field].type, 'uint64')
    for (const value of ['-9223372036854775808', '-2086648496', '-1', '0', '9007199254740993', '9223372036854775807']) {
        const decoded = p.decode('BattleVerifyInfo', p.encode('BattleVerifyInfo', { source_id: value }))
        assert.equal(i64(decoded.source_id), value)
    }
    assert.equal(i64('-0001'), '-1')
    assert.equal(i64(-1), '-1')
    assert.equal(i64(), '0')
    for (const value of ['-9223372036854775809', '9223372036854775808', '1.5', '1e3', '+1', '', NaN, 9007199254740992])
        assert.throws(() => i64(value), /Invalid int64/)
    assert.throws(() => u64('-1'), /Invalid uint64/)
    assert.throws(() => expandBattleReport({ uint64_dic: ['-1'] }), /Invalid uint64/)
})

test('negative skill, bullet and element source IDs remain signed provenance rather than actor GUIDs or causal indexes', () => {
    const c = { state: { world: { map_id: 1052 }, combat: { npcDuel: { map_id: 1052 } } } }
    recordArenaSkillOrigin(c, {
        unit_id: '123',
        skill: { skill_id: 5030012 },
        verify_info: { battle_index: '100', source_id: '-2086648496' },
    })
    recordArenaBulletOrigin(c, '123', {
        bullet_id: '200',
        config_id: 50300121,
        skill_id: 5030012,
        verify_info: { battle_index: '101', related_index: '100', source_type: 1, source_id: '-9223372036854775808' },
    })
    recordArenaElementOrigin(c, {
        op: 1,
        uniqueId: '201',
        tar_id: '456',
        buff: { cfg_id: 503001101, source_id: '123' },
        verify_info: { battle_index: '102', related_index: '101', source_type: 3, source_id: '-1' },
    })
    const run = c.state.combat.npcDuel
    assert.equal(run.origin_nodes['100'].source_id, '-2086648496')
    assert.equal(run.origin_nodes['101'].source_id, '-9223372036854775808')
    assert.equal(run.origin_nodes['102'].source_id, '-1')
    assert.equal(arenaElementOrigin(c, { battle_index: '102' }).skill_id, 5030012)
    assert.throws(
        () =>
            recordArenaSkillOrigin(c, {
                unit_id: '123',
                skill: { skill_id: 5030012 },
                verify_info: { battle_index: '-1', source_id: '-1' },
            }),
        /Invalid uint64/,
    )
})

test('recorded rejected mixed batch now applies HP and live/result statistics atomically and retries only acknowledge', () => {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, request) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-signed-origin-stats' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        const run = state().combat.npcDuel
        const actors = Object.values(run.actors).filter((a) => run.in_fight[a.uuid])
        const self = actors.find((a) => a.camp === 1),
            enemy = actors.find((a) => a.camp === 2)
        const raw = expandBattleReport(captured.request),
            rawSelf = raw.find((row) => row.hurt_info).hurt_info.from_id
        const request = structuredClone(captured.request)
        // Retain the recorded 14-event batch, config/time/index/sign fields.
        // Map its actor identities to this isolated test match; both recorded
        // enemy targets use the active fixture victim so both hits are applied.
        request.uint64_dic = request.uint64_dic.map((id) =>
            BigInt(id) >> 56n === 20n ? (id === rawSelf ? self.uuid : enemy.uuid) : id,
        )
        request.base_time = String(now * 1000)
        const originalPacket = game.packet,
            before = structuredClone(state())
        const writes = store.db.prepare('SELECT total_changes() AS n').get().n
        game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('signed batch packet fault')
            return originalPacket.call(this, name, ...args)
        }
        assert.throws(() => call('BattleInfoReduce', request), /signed batch packet fault/)
        game.packet = originalPacket
        assert.deepEqual(state(), before, 'HP, provenance, hurt receipts and statistics roll back together')
        const packets = call('BattleInfoReduce', request)
        assert.equal(state().combat.entities[enemy.uuid].hp, before.combat.entities[enemy.uuid].hp - 336)
        const live = packets.find((packet) => packet.id === 10756).data.damage_record
        assert.equal(live.find((row) => row.uuid === self.uuid).damage, 336)
        assert.equal(live.find((row) => row.uuid === enemy.uuid).take_damage, 336)
        assert.ok(Object.values(state().combat.npcDuel.origin_nodes).some((row) => row.source_id === '-2086648496'))
        const retry = call('BattleInfoReduce', request)
        assert.equal(retry.find((packet) => packet.id === 10706).data.battle_info.length, 2)
        assert.equal(state().combat.npcDuel.statistics[self.uuid].damage, 336)
        assert.equal(
            store.db.prepare('SELECT total_changes() AS n').get().n,
            writes,
            'frequent battle processing stays in memory',
        )
        const end = call('KiboDuelSurrender')
        assert.ok(end.findIndex((packet) => packet.id === 10756) < end.findIndex((packet) => packet.id === 11806))
        assert.equal(
            end.find((packet) => packet.id === 10756).data.damage_record.find((row) => row.uuid === self.uuid).damage,
            336,
        )
        const expected = npcArenaStatistics(state())
        session = {}
        const login = call('EnterGame', { open_id: 'npc-signed-origin-stats' })
        assert.deepEqual(
            login.find((packet) => packet.id === 10756).data.damage_record,
            p.decode('KiboDuelStats', p.encode('KiboDuelStats', expected)).damage_record,
        )
    } finally {
        store.close()
    }
})
