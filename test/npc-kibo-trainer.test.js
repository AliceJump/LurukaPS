import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { temporaryHeroes, isRetiredTrialActor } from '../src/trial-actors.js'
import { expireArenaTrialTrainer } from '../src/npc-kibo-trainer.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

for (const duel of tables.get('kibo_duel').filter((row) => row.type === 1 && row.trialRole)) {
    test(`NPC${duel.id} uses the configured trial trainer without changing owned heroes, including reconnect and exit`, () => {
        let now = 1800000000,
            seq = 1,
            session = {}
        const store = new Store(':memory:'),
            game = new Game(p, store, tables, { clock: () => now })
        const openId = `arena-trainer-${duel.id}`
        const decode = (packets) =>
            packets.map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
        const call = (name, data = {}) => {
            const entry = p.byName.get('CSProto' + name)
            return decode(game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, data) }))
        }
        const state = () => store.load(session.id).state
        try {
            call('EnterGame', { open_id: openId })
            store.transact(session.id, 0, (s) => {
                const owned = s.player.heros_info.heros.find((hero) => hero.conf_id === 107001)
                if (duel.id === 506)
                    s.player.heros_info.heros = s.player.heros_info.heros.filter((hero) => hero !== owned)
                else {
                    owned.hero_lv = 60
                    owned.hero_star = 4
                    owned.hero_grade = 3
                }
            })
            const owned = structuredClone(state().player.heros_info.heros),
                originalParty = structuredClone(state().player.group_mgrs.find((manager) => manager.type === 1)),
                originalWorld = structuredClone(state().world)
            call('KiboDuelGetGroup', { u32: duel.id })
            const group = structuredClone(state().kiboDuelGroups[0])
            assert.equal(group.hero, '107001', 'trial preparation carries the configured hero ID')
            assert.ok(group.pet_guids.every((pet) => pet.is_trial))
            call('KiboDuelGroupChange', { type: 6, group })
            assert.throws(
                () => call('KiboDuelGroupChange', { type: 6, group: { ...group, hero: '987654321' } }),
                /not owned/,
            )
            const teaching = tables.get('train_task').some((row) => row.groupType === 3 && row.dungeonId === duel.id)
            const enter = teaching
                ? call('KiboDuelStart', { u32: duel.id })
                : call('MultiCampaignCreate', { dungeon_id: duel.dungeonId })
            const trialId = p.byName.get('CSProtoTrialDatas').id
            const hero = enter
                .find((packet) => packet.id === trialId)
                .data.trial_heros.find((hero) => hero.conf_id === 107001)
            assert.ok(hero)
            assert.equal(BigInt(hero.guid) >> 56n, 5n)
            assert.equal(hero.hero_lv, 1)
            assert.equal(hero.hero_star, 0)
            assert.equal(hero.trail, true)
            const attrs = enter.find((packet) => packet.id === 11801).data.attr.hero_info
            assert.equal(attrs.hero_guid, hero.guid)
            assert.equal(attrs.hero_conf_id, hero.conf_id)
            assert.equal(attrs.hero_lv, 1)
            assert.equal(state().combat.npcDuel.trainer_grade, attrs.hero_grade)
            assert.equal(state().combat.npcDuel.trainer_grade, hero.hero_grade)
            assert.ok(
                enter.findIndex((packet) => packet.id === trialId) < enter.findIndex((packet) => packet.id === 11801),
                'HeroStore must register the trial actor before the arena adapter loads',
            )
            assert.equal(state().multiCampaign.formation_slot, 0)
            assert.equal(temporaryHeroes(state()).find((actor) => actor.guid === hero.guid).hero_lv, 1)
            assert.deepEqual(state().player.heros_info.heros, owned)
            assert.deepEqual(
                state().player.group_mgrs.find((manager) => manager.type === 1),
                originalParty,
            )
            call('MultiCampaignPlayerLoaded')
            call('MultiCampaignPlayerLoadFinish')
            const destination = { ...state().world.pos, z: state().world.pos.z + 25 }
            call('StateUpdate', {
                move_msg: {
                    map_id: state().world.map_id,
                    move: [{ uuid: hero.guid, info: { pos: destination, angle: 45 } }],
                },
            })
            assert.deepEqual(state().world.pos, destination)
            call('SkillStart', { unit_id: hero.guid, skill: { skill_id: 19999903, slot: 701 } })
            session = {}
            const login = call('EnterGame', { open_id: openId })
            assert.ok(
                login.findIndex((packet) => packet.id === trialId) < login.findIndex((packet) => packet.id === 11801),
            )
            assert.equal(login.find((packet) => packet.id === 11801).data.attr.hero_info.hero_guid, hero.guid)
            assert.equal(login.find((packet) => packet.id === 11874).data.infos[0].hero_conf_id, hero.conf_id)
            call('MultiCampaignPlayerLoaded')
            call('MultiCampaignPlayerLoadFinish')
            call('KiboDuelArenaFirstConfirmReq')
            now = state().combat.npcDuel.intro_until
            game.tick(session.id, session)
            call('KiboDuelSurrender')
            assert.equal(state().combat.npcDuel.result.result, 2)
            const exit = call(teaching ? 'KiboDuelQuit' : 'MultiCampaignQuit')
            assert.ok(
                exit
                    .find((packet) => packet.id === trialId)
                    .data.trial_heros.every((actor) => actor.guid !== hero.guid),
            )
            assert.equal(state().npcArenaTrialTrainer, undefined)
            assert.ok(!state().player.heros_info.battle_infos.some((info) => info.hero_id === hero.guid))
            assert.equal(isRetiredTrialActor(state(), hero.guid), true)
            assert.deepEqual(state().player.heros_info.heros, owned)
            assert.deepEqual(
                state().player.group_mgrs.find((manager) => manager.type === 1),
                originalParty,
            )
            assert.equal(state().world.map_id, originalWorld.map_id)
            assert.deepEqual(state().world.pos, originalWorld.pos)
            assert.doesNotThrow(() => call('SkillStop', { unit_id: hero.guid, skill_id: '19999903' }))
        } finally {
            store.close()
        }
    })
}

test('arena trial trainer expires after an external scene change without removing other trial actors', () => {
    const hero = { guid: '360747558679216129' },
        other = { guid: '123' }
    const state = {
        world: { map_id: 100 },
        multiCampaign: { duel_id: 502 },
        npcArenaTrialTrainer: { duel_id: 502, map_id: 1052, hero },
        trialGroup: { heroes: [other] },
        player: { heros_info: { battle_infos: [{ hero_id: hero.guid }, { hero_id: other.guid }] } },
    }
    assert.equal(expireArenaTrialTrainer(state), true)
    assert.deepEqual(temporaryHeroes(state), [other])
    assert.deepEqual(state.player.heros_info.battle_infos, [{ hero_id: other.guid }])
})

test('commission teaching10746 prepares its fixed trial roster directly; unrelated old-mode starts remain explicit', () => {
    const store = new Store(':memory:'),
        session = {},
        game = new Game(p, store, tables)
    let seq = 1
    const call = (name, data = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, data) })
    }
    try {
        call('EnterGame', { open_id: 'direct-teaching-entry' })
        const trialPet = tables.find('trial_pet', 10085).trialPet
        store.transact(session.id, 0, (state) => {
            state.pets = state.pets.filter((pet) => pet.config_id !== trialPet)
            state.player.heros_info.heros = state.player.heros_info.heros.filter((hero) => hero.conf_id !== 107001)
        })
        const before = structuredClone(store.load(session.id).state)
        assert.throws(() => call('KiboDuelStart', { u32: 1001 }), /teaching entry/)
        assert.deepEqual(store.load(session.id).state, before)
        const packets = call('KiboDuelStart', { u32: 502 })
        assert.ok(packets.some((packet) => packet.id === 11801))
        const state = store.load(session.id).state
        assert.equal(state.multiCampaign.duel_id, 502)
        assert.equal(state.multiCampaign.formation_slot, 0)
        assert.equal(Object.keys(state.combat.npcDuel.actors).length, 16)
        assert.equal(state.npcArenaTrialTrainer.hero.conf_id, 107001)
        assert.ok(state.kiboDuelTrialProfiles[10085])
        call('KiboDuelQuit')
        assert.equal(store.load(session.id).state.world.map_id, before.world.map_id)
        assert.equal(store.load(session.id).state.npcArenaTrialTrainer, undefined)
    } finally {
        store.close()
    }
})
