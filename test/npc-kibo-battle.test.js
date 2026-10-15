import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPetAttributes } from '../src/kibo-arena-attributes.js'
import { arenaPoint, npcArenaAppearances } from '../src/npc-kibo-battle.js'
import { npcDuelEntry } from '../src/npc-kibo-duel.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

test('all linked NPC formations have arena templates, skills and real prefab spawn points', () => {
    for (const duel of tables.get('kibo_duel').filter((x) => x.type === 1 && x.id !== 20001)) {
        const entry = npcDuelEntry(tables, duel.id)
        for (const field of ['nestBorthPos1', 'nestBorthPos2', 'SummonPos1', 'SummonPos2'])
            assert.ok(Number.isInteger(arenaPoint(tables, entry.map, field).pos.x))
        for (const pet of entry.enemyPets) {
            const data = arenaPetAttributes(tables, pet, duel.recommendLevel)
            assert.ok(data.hp > 0)
            assert.ok(data.skills[0].sub_modules[0].skills.skills.length)
        }
    }
    const wind = arenaPetAttributes(tables, 500020, 5)
    // Actual CBT3 arena template1500020 * growth5002005, no ordinary aptitude.
    assert.equal(wind.hp, Math.floor(Math.fround(9455 * 3036) / 10000))
    assert.equal(wind.attrs.attrs.find((x) => x.attr_id === 1).attr_val, String(9720 * 221))
    assert.equal(wind.attrs.attrs.find((x) => x.attr_id === 110).attr_val, '0')
    assert.ok(wind.skills[0].sub_modules[0].skills.skills.some((x) => x.skill_slot === 1 && x.skill_id === 5030012))
})

test('NPC arena publishes both rosters, waits for entity readiness, and validates memory-only summoning', () => {
    let now = 1800000000
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now }),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, request) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-arena-combat' })
        call('KiboDuelGetGroup', { u32: 501 })
        const entered = call('MultiCampaignCreate', { dungeon_id: 40007 })
        assert.equal(entered.find((x) => x.id === 11055).data.mode, 9)
        assert.equal(entered.find((x) => x.id === 11800).data.status, 2)
        assert.throws(() => call('KiboDuelArenaFirstConfirmReq'), /No first arena pet/)
        assert.throws(() => call('MultiCampaignPlayerLoadFinish'), /not been published/)
        const loaded = call('StartDungeonClientOk')
        const players = loaded.find((x) => x.id === 11700).data.player_info
        assert.equal(players.length, 2)
        assert.equal(players[1].attr.infos.length, 8)
        const objects = loaded.find((x) => x.id === 11064).data.obj
        assert.equal(objects.filter((x) => x.obj.obj_type === 20).length, 16)
        assert.equal(objects.filter((x) => x.obj.obj_type === 23).length, 1)
        const trainer = objects.find((x) => x.obj.obj_type === 23)
        assert.equal(trainer.agent_type, 7)
        assert.ok(!loaded.filter((x) => x.id === 11067).some((x) => x.data.agent_uid === trainer.agent_uid))
        assert.ok(objects.every((x) => x.obj.obj_data[0].cli_battle_data.fobj_base_data.hp > 0))
        assert.equal(new Set(objects.map((x) => x.agent_uid)).size, 17)
        assert.ok(
            !call('StartDungeonClientOk').some((x) => x.id === 11064),
            'duplicate scene-ready must not recreate units',
        )
        call('MultiCampaignPlayerLoadFinish')
        const confirmed = call('KiboDuelArenaFirstConfirmReq')
        assert.ok(!confirmed.some((x) => x.id === 11811))
        assert.equal(confirmed.find((x) => x.id === 11807).data.stage, '2')
        assert.equal(confirmed.find((x) => x.id === 11800).data.status, 6)
        now = state().combat.npcDuel.intro_until
        const deployed = game.tick(session.id, session)
        assert.ok(deployed.some((x) => x.id === 11811))
        const run = state().combat.npcDuel
        const enemy = Object.values(run.actors).find((x) => x.camp === 2 && !run.in_fight[x.uuid])
        const friends = Object.values(run.actors).filter((x) => x.camp === 1 && !run.in_fight[x.uuid])
        const request = (actor) => ({
            pet_guid: actor.uuid,
            source_pet_guid: actor.source_guid,
            pos: { ...(actor.camp === 1 ? run.positions.selfSummon.pos : run.positions.enemySummon.pos) },
            angle: 270,
        })
        const writes = store.db.prepare('SELECT total_changes() AS n').get().n
        const npcSummon = call('PVEEnemySummonReq', { ...request(enemy), source_pet_guid: '0' })
        assert.equal(npcSummon.find((x) => x.id === 11811).data.changes[0].kibo_guid, enemy.uuid)
        const ultra = (guid, cast_ultra_skill) => call('KiboCastUltraSkill', { guid, cast_ultra_skill })
        assert.equal(ultra(enemy.uuid, false).length, 0)
        assert.equal(state().combat.npcDuel.ultra_choices[enemy.source_guid], false)
        assert.equal(ultra(enemy.uuid, true).length, 0)
        assert.equal(state().combat.npcDuel.ultra_choices[enemy.source_guid], true)
        ultra(friends[0].source_guid, false)
        assert.equal(state().combat.npcDuel.ultra_choices[friends[0].source_guid], false)
        assert.throws(() => ultra('123', true), /not in this duel/)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const snapshot = structuredClone(state().combat.npcDuel.in_fight)
        assert.throws(() => call('PVEEnemySummonReq', request(friends[0])), /not in this arena camp/)
        assert.deepEqual(state().combat.npcDuel.in_fight, snapshot)
        assert.throws(
            () => call('KiboDuelArenaSummonReq', { ...request(friends[0]), source_pet_guid: '123' }),
            /source mismatch/,
        )
        call('KiboDuelArenaSummonReq', request(friends[0]))
        now += 3
        call('KiboDuelArenaSummonReq', request(friends[1]))
        assert.throws(() => call('KiboDuelArenaSummonReq', request(friends[2])), /field is full/)
        now += 3
        call('KiboDuelArenaSummonReq', { ...request(friends[2]), replace_kibo_guid: friends[0].uuid })
        assert.equal(state().combat.npcDuel.in_fight[friends[0].uuid], undefined)
        const source = friends[2].uuid
        const worldPosition = structuredClone(state().world.pos)
        const position = { ...friends[2].pos, x: friends[2].pos.x + 123 }
        call('StateUpdate', {
            move_msg: { map_id: run.map_id, move: [{ uuid: source, info: { pos: position, angle: 90 } }] },
        })
        assert.deepEqual(state().world.pos, worldPosition)
        assert.deepEqual(
            npcArenaAppearances(state()).obj.find((x) => x.agent_uid === source).obj.obj_data[0].cli_battle_data
                .fobj_base_data.move_info.pos,
            position,
        )
        const beforeMove = structuredClone(state().combat.npcDuel.in_fight)
        assert.throws(
            () =>
                call('StateUpdate', {
                    move_msg: {
                        map_id: run.map_id,
                        move: [
                            { uuid: source, info: { pos: { ...position, x: position.x + 1 } } },
                            { uuid: friends[1].uuid, info: {} },
                        ],
                    },
                }),
            /Invalid arena movement/,
        )
        assert.deepEqual(state().combat.npcDuel.in_fight, beforeMove)
        call('BattleInfoReduce', {
            uint64_dic: [source, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp } }],
        })
        assert.equal(state().combat.entities[enemy.uuid].hp, 0)
        assert.equal(state().combat.entities[enemy.uuid].alive_state, 1)
        assert.equal(state().combat.npcDuel.in_fight[enemy.uuid], undefined)
        assert.equal(state().combat.npcDuel.scores[2], 875)
        call('BattleInfoReduce', {
            uint64_dic: [source, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp } }],
        })
        assert.equal(state().combat.npcDuel.scores[2], 875, 'duplicate death report does not deduct score twice')
        const hero = state().player.heros_info.battle_infos[0]
        const heroHp = hero.hp
        call('BattleInfoReduce', {
            uint64_dic: [enemy.uuid, hero.hero_id],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -heroHp } }],
        })
        assert.equal(
            state().player.heros_info.battle_infos[0].hp,
            heroHp,
            'arena combat does not damage the overworld trainer',
        )
        assert.equal(
            store.db.prepare('SELECT total_changes() AS n').get().n,
            writes,
            'summons and combat must remain in memory',
        )
    } finally {
        store.close()
    }
})
