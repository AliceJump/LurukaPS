import test from 'node:test'
import assert from 'node:assert/strict'
import { arenaElementMetadata, arenaConfiguredInjections } from '../src/npc-kibo-elements.js'
import { recordArenaElementOrigin, arenaElementOrigin } from '../src/npc-kibo-origins.js'

test('all-family metadata includes non-damage parents, preserves conflicts and does not invent missing entries', () => {
    assert.equal(arenaElementMetadata(30900802).type, 'ConfigTBuffElementParams')
    assert.equal(arenaElementMetadata(503001101).type, 'ConfigTDamageElementParams')
    assert.equal(arenaElementMetadata(503001101).snapshot, false)
    assert.equal(arenaElementMetadata(18009046).snapshot, true)
    assert.equal(arenaElementMetadata(108001162).status, 'ambiguous')
    assert.equal(arenaElementMetadata(999999999).status, 'unavailable')
})

test('configured paths distinguish Buff inheritance from Stack/Weather independent configuration without claiming runtime proof', () => {
    const buff = arenaConfiguredInjections(30900802, 30900804)
    assert.equal(buff.status, 'configured')
    assert.equal(buff.paths[0].policy, 'parent-after-parse')
    assert.equal(buff.paths[0].path, 'injectElementDataList[0]')
    assert.equal(arenaConfiguredInjections(102001132, 802).paths[0].policy, 'own')
    assert.equal(arenaConfiguredInjections(500004040, 500004041).paths[0].policy, 'own')
    assert.equal(arenaConfiguredInjections(30900802, 802).status, 'not-listed')
    assert.equal(arenaConfiguredInjections(108001162, 802).status, 'configuration-unavailable')
})

test('live generic element provenance stores actual metadata but does not infer a skill or snapshot execution from a configured edge', () => {
    const c = { state: { world: { map_id: 1052 }, combat: { npcDuel: { map_id: 1052 } } } }
    const event = (id) => ({
        op: 1,
        uniqueId: '9007199254740993',
        buff: { cfg_id: id, source_id: '12' },
        verify_info: { battle_index: '4294967396', source_type: 2, related_index: '4294967395' },
    })
    recordArenaElementOrigin(c, event(30900802))
    const node = c.state.combat.npcDuel.origin_nodes['4294967396']
    assert.equal(node.uid, '9007199254740993')
    assert.equal(node.element_type, 'ConfigTBuffElementParams')
    assert.equal(node.configured_snapshot, false)
    assert.equal(node.root, undefined)
    assert.equal(node.snapshots, undefined)
    assert.equal(arenaElementOrigin(c, event(30900802).verify_info).status, 'missing-parent')
    recordArenaElementOrigin(c, { ...event(108001162), uniqueId: '77', verify_info: { battle_index: '22' } })
    const ambiguous = c.state.combat.npcDuel.origin_nodes['22']
    assert.equal(ambiguous.element_metadata_status, 'ambiguous')
    assert.equal(ambiguous.element_type, undefined)
    assert.equal(ambiguous.configured_snapshot, undefined)
})

test('Trigger effect paths retain the native parse order and phase while conflicting variants remain unavailable', () => {
    const trigger = arenaElementMetadata(19010403)
    assert.equal(trigger.type, 'ConfigTTriggerElementParams')
    assert.equal(trigger.snapshot, true)
    assert.deepEqual(trigger.trigger, { time_first_frame: true, zero_effect_count: 0 })
    const child = arenaConfiguredInjections(19010403, 19010402)
    assert.equal(child.status, 'configured')
    assert.equal(child.paths[0].policy, 'parent-before-parse')
    assert.equal(child.paths[0].path, 'triggerEffectList[0]')
    assert.equal(arenaConfiguredInjections(510110201, 14002).status, 'configured')
})
