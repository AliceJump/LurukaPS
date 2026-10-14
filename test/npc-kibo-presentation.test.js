import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { npcArenaPresentation } from '../src/npc-kibo-presentation.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

test('all linked NPC entry presentations use the actual map story and extracted master Timeline', () => {
    for (const row of tables.get('kibo_duel').filter((x) => x.type === 1 && x.id !== 20001)) {
        const presentation = npcArenaPresentation(tables, row.id)
        assert.equal(presentation.storyId, tables.find('kibo_duel_map', row.mapId).KiboEnterStoryID)
        // Verified native delay4 + extracted Timeline17 + table endCover1.5.
        assert.equal(presentation.seconds, 23)
    }
})

test('first confirmation plays STINGER FIRST before opening combat, including intro relogin', () => {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now })
    const state = () => store.load(session.id).state
    const decode = (packets) => packets.map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
    const call = (name, request = {}) => {
        const e = p.byName.get('CSProto' + name)
        return decode(game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, request) }))
    }
    try {
        call('EnterGame', { open_id: 'npc-intro' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        const first = call('KiboDuelArenaFirstConfirmReq')
        assert.equal(first.find((x) => x.id === 11807).data.stage, '2')
        assert.ok(first.findIndex((x) => x.id === 11807) < first.findIndex((x) => x.id === 11800))
        assert.equal(first.find((x) => x.id === 11800).data.status, 6)
        assert.equal(state().combat.npcDuel.intro_story_id, 6120002)
        assert.equal(state().combat.npcDuel.regular_started_at, undefined)
        assert.ok(!first.some((x) => x.id === 11814))
        const own = Object.values(state().combat.npcDuel.actors).find((x) => x.camp === 1)
        const enemy = Object.values(state().combat.npcDuel.actors).find((x) => x.camp === 2)
        call('BattleInfoReduce', {
            uint64_dic: [own.uuid, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp } }],
        })
        assert.equal(state().combat.entities[enemy.uuid].hp, enemy.max_hp)
        now += 5
        session = {}
        const login = call('EnterGame', { open_id: 'npc-intro' })
        assert.equal(login.find((x) => x.id === 11800).data.status, 2)
        call('MultiCampaignPlayerLoaded')
        const resumed = call('MultiCampaignPlayerLoadFinish')
        assert.deepEqual(
            resumed.filter((x) => x.id === 11800).map((x) => x.data.status),
            [3, 6],
        )
        const until = state().combat.npcDuel.intro_until
        now++
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        assert.equal(state().combat.npcDuel.intro_until, until)
        now = until - 1
        game.tick(session.id, session)
        assert.equal(state().multiCampaign.arena_status, 6)
        assert.equal(state().combat.npcDuel.energy, undefined)
        now++
        const begun = decode(game.tick(session.id, session))
        assert.equal(begun.find((x) => x.id === 11800).data.status, 4)
        assert.equal(state().combat.npcDuel.regular_started_at, now)
        assert.equal(state().combat.npcDuel.end_at, now + 300)
        assert.equal(state().combat.npcDuel.energy[1].points, 100)
        call('MultiCampaignQuit')
        assert.equal(call('KiboDuelArenaAutoFightSync', { status: 2 }).length, 0)
        assert.throws(() => call('KiboDuelArenaAutoFightSync', { status: 1 }), /Invalid arena/)
    } finally {
        store.close()
    }
})
