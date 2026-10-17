import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { npcDuelEntry, validateNpcDuelFormation } from '../src/npc-kibo-duel.js'
import { arenaPoint } from '../src/npc-kibo-battle.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

test('CBT3 NPC1016 loads through9596 without9509; duplicate callbacks preserve actors and relogin starts a new challenge', () => {
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
        assert.ok(!call('EnterGame', { open_id: 'npc9596-loading' }).some((x) => x.id === 11064))
        assert.ok(!call('MultiCampaignPlayerLoaded').some((x) => x.id === 11064))
        call('KiboDuelGetGroup', { u32: 1016 })
        const group = structuredClone(state().kiboDuelGroups[0])
        const owned = state().pets[Symbol.iterator]()
        for (let i = 0; i < group.pet_guids.length; i++)
            if (group.pet_guids[i].id === '0') group.pet_guids[i] = { id: owned.next().value.guid, is_trial: false }
        call('KiboDuelGroupChange', { type: 6, group })
        call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', 1016).dungeonId })
        const trainerSpawn = arenaPoint(tables, tables.find('kibo_duel_map', 20006), 'nestBorthPos1', 100)
        assert.deepEqual(state().world.pos, trainerSpawn.pos)
        // Reproduce the real trace:9510 ->9596, with no9509.
        const loaded = call('MultiCampaignPlayerLoaded')
        const entities = loaded.find((x) => x.id === 11064).data.obj
        const uuids = entities.map((x) => x.agent_uid)
        assert.equal(entities.length, 17)
        // CBT3 SceneService refuses batch AOI under the new proxy's default
        // mode. The9596 response must set PvE9 before publishing actors.
        assert.equal(loaded.find((x) => x.id === 11055).data.mode, 9)
        assert.ok(loaded.findIndex((x) => x.id === 11055) < loaded.findIndex((x) => x.id === 11064))
        assert.equal(loaded.find((x) => x.id === 11700).data.player_info.length, 2)
        const npcInfo = loaded.find((x) => x.id === 11700).data.player_info[1]
        const npcFirst = loaded.find((x) => x.id === 11802).data
        assert.equal(npcFirst.id, npcInfo.player_id)
        assert.equal(npcFirst.pet_guid, npcInfo.attr.infos[0].pet_guid.guid)
        assert.ok(loaded.findIndex((x) => x.id === 11700) < loaded.findIndex((x) => x.id === 11802))
        assert.ok(loaded.findIndex((x) => x.id === 11700) < loaded.findIndex((x) => x.id === 11064))
        assert.equal(state().multiCampaign.arena_status, 2)
        assert.equal(state().multiCampaign.status, 3)
        for (const callback of ['MultiCampaignPlayerLoaded', 'StartDungeonClientOk'])
            assert.ok(!call(callback).some((x) => x.id === 11064))
        assert.equal(p.byName.get('CSProtoMultiCampaignPlayerLoadFinish').id, 9602)
        assert.equal(p.byName.get('CSProtoMultiCampaignPlayerLoadingPageComplete').id, 9604)
        assert.throws(() => call('MultiCampaignPlayerLoadingPageComplete'), /entities are not ready/)
        assert.equal(state().multiCampaign.arena_status, 2)
        const ready = call('MultiCampaignPlayerLoadFinish')
        assert.equal(ready.find((x) => x.id === 11800).data.status, 3)
        assert.equal(ready.find((x) => x.id === 9603).data.u32, session.id)
        const deadline = state().combat.npcDuel.first_until
        now++
        assert.ok(!call('MultiCampaignPlayerLoadFinish').some((x) => x.id === 11800))
        assert.ok(!call('MultiCampaignPlayerLoadingPageComplete').some((x) => x.id === 11800))
        assert.equal(state().combat.npcDuel.first_until, deadline)
        call('KiboDuelArenaFirstConfirmReq')
        assert.equal(state().multiCampaign.arena_status, 6)
        assert.equal(state().combat.npcDuel.regular_started_at, undefined)
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        assert.equal(state().multiCampaign.arena_status, 4)
        assert.ok(
            Object.values(state().combat.npcDuel.actors).some(
                (actor) =>
                    actor.source_guid === npcFirst.pet_guid && state().combat.npcDuel.in_fight[actor.uuid]?.first,
            ),
        )
        const fighting = structuredClone(state().combat.npcDuel.in_fight)
        store.transact(session.id, 0, (s) => {
            const position = String(tables.find('dungeon', 40028).position).split('|').map(Number)
            s.world.pos = {
                x: Math.round(position[0] * 100),
                y: Math.round(position[1] * 100),
                z: Math.round(position[2] * 100),
            }
        })
        now += 2
        session = {}
        call('EnterGame', { open_id: 'npc9596-loading' })
        assert.equal(state().multiCampaign, undefined)
        call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', 1016).dungeonId })
        assert.deepEqual(state().world.pos, trainerSpawn.pos)
        assert.equal(state().world.angle, trainerSpawn.angle)
        const resumed = call('MultiCampaignPlayerLoaded')
        assert.notEqual(resumed.find((x) => x.id === 11802).data.pet_guid, npcFirst.pet_guid)
        assert.equal(resumed.find((x) => x.id === 11055).data.mode, 9)
        assert.ok(resumed.findIndex((x) => x.id === 11055) < resumed.findIndex((x) => x.id === 11064))
        const restarted = resumed.find((x) => x.id === 11064).data.obj
        assert.equal(restarted.length, uuids.length)
        assert.ok(restarted.filter((x) => x.obj.obj_type === 20).every((x) => !uuids.includes(x.agent_uid)))
        assert.deepEqual(state().combat.npcDuel.in_fight, {})
        assert.ok(Object.keys(fighting).length > 0)
        call('MultiCampaignPlayerLoadFinish')
        assert.equal(state().multiCampaign.arena_status, 3)
    } finally {
        store.close()
    }
})

test('all current NPC arena routes are derived from linked CBT3 tables; broken table links remain explicit', () => {
    const rows = tables.get('kibo_duel').filter((row) => row.type === 1)
    const failures = []
    let valid = 0
    for (const row of rows) {
        try {
            const entry = npcDuelEntry(tables, row.id)
            assert.equal(entry.dungeon.gameplayID, row.id)
            assert.equal(entry.enemyPets.length, 8)
            assert.ok(entry.enemyPets.every((id) => tables.find('pet', id)))
            valid++
        } catch (error) {
            failures.push({ id: row.id, error: error.message })
        }
    }
    assert.equal(valid, 217)
    // 20001 points at generic dungeon50000/gameplay1 rather than NPC20001.
    assert.deepEqual(failures, [{ id: 20001, error: 'NPC duel dungeon mapping unavailable' }])
})

test('player-selected NPC arena slot persists and supplies11801 attributes before scene status, including relogin', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, tables)
    let session = {},
        seq = 1
    const call = (name, request = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, request) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    try {
        call('EnterGame', { open_id: 'npc-arena-player-formation' })
        call('KiboDuelGetGroup', { u32: 2 })
        const state = store.load(session.id).state
        const hero = state.player.heros_info.heros[0]
        const pets = state.pets.slice(0, 8).map((pet) => ({ id: pet.guid, is_trial: false }))
        assert.equal(pets.length, 8)
        const formation = { slot: 2, duel_id: 2, hero: hero.guid, pet_guids: pets, hero_skills: [] }
        assert.throws(
            () =>
                validateNpcDuelFormation(tables, state, tables.find('kibo_duel', 2), {
                    ...formation,
                    pet_guids: Array(8).fill(pets[0]),
                }),
            /Duplicate/,
        )
        assert.throws(
            () =>
                validateNpcDuelFormation(tables, state, tables.find('kibo_duel', 2), {
                    ...formation,
                    pet_guids: [{ id: '500135', is_trial: true }, ...pets.slice(1)],
                }),
            /not allowed/,
        )
        call('KiboDuelGroupChange', { type: 6, group: formation })
        call('SetKiboDuelCurGroup', { type: 6, cur_group: 2 })
        const entered = call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', 2).dungeonId })
        const single = entered.find((x) => x.id === 11801)
        assert.ok(single)
        assert.equal(single.data.dungeon_id, 40001)
        assert.equal(single.data.player_id, session.id)
        assert.equal(single.data.player_camp, 1)
        assert.deepEqual(
            single.data.attr.infos.map((x) => x.pet_guid.guid),
            pets.map((x) => x.id),
        )
        assert.ok(entered.indexOf(single) < entered.findIndex((x) => x.id === 11800))
        assert.equal(store.load(session.id).state.multiCampaign.formation_slot, 2)
        session = {}
        const returned = call('EnterGame', { open_id: 'npc-arena-player-formation' })
        assert.ok(!returned.some((x) => x.id === 11801))
        assert.equal(store.load(session.id).state.multiCampaign, undefined)
        assert.equal(store.load(session.id).state.player.group_mgrs.find((group) => group.type === 6).cur_group, 2)
        const resumed = call('MultiCampaignCreate', { dungeon_id: tables.find('kibo_duel', 2).dungeonId })
        assert.deepEqual(
            resumed.find((x) => x.id === 11801).data.attr.infos.map((x) => x.pet_guid.guid),
            pets.map((x) => x.id),
        )
        call('MultiCampaignQuit')
        assert.equal(store.load(session.id).state.kiboDuelRecords?.[2], undefined)
    } finally {
        store.close()
    }
})
