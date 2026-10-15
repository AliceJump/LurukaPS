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

test('all linked NPC entry presentations use the map story and configured FIRST stage window', () => {
    for (const row of tables.get('kibo_duel').filter((x) => x.type === 1 && x.id !== 20001)) {
        const presentation = npcArenaPresentation(tables, row.id)
        assert.equal(presentation.storyId, tables.find('kibo_duel_map', row.mapId).KiboEnterStoryID)
        assert.equal(
            presentation.seconds,
            Number(tables.get('game').find((x) => x.title === 'KIBO_DUEL_ARENA_MODE_FIRST_TIME').value),
        )
    }
})

test('first confirmation plays STINGER FIRST before opening combat, including intro relogin', () => {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        configuredTables = new Tables(cfg.tables)
    configuredTables.cache.set(
        'game',
        tables
            .get('game')
            .map((row) => (row.title === 'KIBO_DUEL_ARENA_MODE_FIRST_KIBO_TIME' ? { ...row, value: '11' } : row)),
    )
    const game = new Game(p, store, configuredTables, { clock: () => now })
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
        const selection = call('MultiCampaignPlayerLoadFinish')
        assert.equal(
            selection.find((x) => x.id === 11800).data.status_endtime,
            String(now + 11),
            'selection uses FIRST_KIBO_TIME independently of the story FIRST_TIME',
        )
        const first = call('KiboDuelArenaFirstConfirmReq')
        assert.ok(!first.some((x) => x.id === 11811), 'story model visibility must not enter either pet into combat')
        assert.equal(first.find((x) => x.id === 11807).data.stage, '2')
        assert.ok(first.findIndex((x) => x.id === 11807) < first.findIndex((x) => x.id === 11800))
        assert.equal(first.find((x) => x.id === 11800).data.status, 6)
        assert.equal(state().combat.npcDuel.intro_story_id, 6120002)
        assert.equal(
            state().combat.npcDuel.intro_until,
            now + 15,
            'the extended Timeline camera hold must not redefine the configured story-stage window',
        )
        assert.equal(state().combat.npcDuel.regular_started_at, undefined)
        assert.deepEqual(state().combat.npcDuel.in_fight, {}, 'card state remains in hand throughout the story')
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
        const reloaded = call('MultiCampaignPlayerLoaded')
        assert.ok(
            reloaded
                .find((x) => x.id === 11064)
                .data.obj.filter((x) => x.obj.obj_type === 20)
                .every((x) => x.obj.obj_data[0].cli_battle_data.pet_base_data.in_fight === false),
            'reconnecting during the story must not initialize floating blood bars through battle card state',
        )
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
        const beforeDeployment = structuredClone(state().combat),
            originalPacket = game.packet
        game.packet = function (name, ...rest) {
            if (name === 'SCProtoKiboInFightChange') throw Error('first deployment packet fault')
            return originalPacket.call(this, name, ...rest)
        }
        assert.throws(() => game.tick(session.id, session), /first deployment packet fault/)
        game.packet = originalPacket
        assert.equal(state().multiCampaign.arena_status, 6)
        assert.deepEqual(
            state().combat,
            beforeDeployment,
            'failed deployment cannot start the clock or spend entry state',
        )
        const begun = decode(game.tick(session.id, session))
        const changes = begun.filter((x) => x.id === 11811).flatMap((x) => x.data.changes)
        assert.equal(changes.length, 2)
        assert.ok(changes.every((x) => x.in_fight && x.is_first))
        assert.deepEqual(new Set(changes.map((x) => x.kibo_guid)), new Set([own.uuid, enemy.uuid]))
        assert.deepEqual(
            changes.find((x) => x.kibo_guid === own.uuid).pos,
            state().combat.npcDuel.positions.selfSummon.pos,
        )
        assert.deepEqual(
            changes.find((x) => x.kibo_guid === enemy.uuid).pos,
            state().combat.npcDuel.positions.enemySummon.pos,
        )
        assert.ok(
            begun.findIndex((x) => x.id === 11811) < begun.findIndex((x) => x.id === 11800),
            'both first pets must enter before the regular battle notification',
        )
        assert.equal(begun.find((x) => x.id === 11800).data.status, 4)
        assert.equal(state().combat.npcDuel.regular_started_at, now)
        assert.equal(state().combat.npcDuel.end_at, now + 300)
        assert.equal(state().combat.npcDuel.energy[1].points, 100)
        assert.ok(Object.values(state().combat.npcDuel.in_fight).every((entry) => entry.entered_at === now))
        now++
        const laterChanges = decode(game.tick(session.id, session))
            .filter((x) => x.id === 11811)
            .flatMap((x) => x.data.changes)
        assert.ok(
            !laterChanges.some((x) => x.kibo_guid === own.uuid || x.kibo_guid === enemy.uuid),
            'later NPC card deployments must not redeploy either first pet',
        )
        call('MultiCampaignQuit')
        assert.equal(call('KiboDuelArenaAutoFightSync', { status: 2 }).length, 0)
        assert.throws(() => call('KiboDuelArenaAutoFightSync', { status: 1 }), /Invalid arena/)
    } finally {
        store.close()
    }
})
