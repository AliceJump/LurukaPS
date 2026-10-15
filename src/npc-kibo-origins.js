import { u64, i64 } from './combat-state.js'
import { arenaElementMetadata, arenaObservedNoSnapshot } from './npc-kibo-elements.js'

const parentKinds = new Map([
    [1, 'skill'],
    [2, 'element'],
    [3, 'bullet'],
])

export function arenaPackedSkillOrigin(value) {
    const packed = BigInt(u64(value)),
        type = Number(packed >> 32n),
        parameter = Number(packed & 0xffffffffn)
    // BuildSourceParam packs fromType/fromParameter, not two actor GUIDs.
    // Only Skill1 identifies a skill; Element3/Bullet4 use other low-word IDs.
    return type === 1 && parameter > 0 && parameter <= 2147483647
        ? { status: 'resolved', skill_id: parameter, via: 'source-param' }
        : { status: 'unsupported-source-param', from_type: type }
}
const activeRun = (c) => {
    const run = c.state.combat?.npcDuel
    return run && run.map_id === c.state.world.map_id && !run.result && run.entities_sent !== false ? run : null
}

export function withoutArenaOrigins(run) {
    const {
        origin_nodes,
        origin_order,
        origin_serial,
        damage_elements,
        damage_input_serial,
        hurt_receipts,
        arena_snapshots,
        snapshot_owners,
        ...rest
    } = run
    return rest
}

export function resetArenaOrigins(c) {
    const run = c.state.combat?.npcDuel
    if (!run) return
    const { damage_input_overflow, hurt_receipts, arena_snapshots, snapshot_owners, ...rest } = run
    c.state.combat.npcDuel = {
        ...rest,
        origin_epoch: (run.origin_epoch ?? 0) + 1,
        origin_nodes: {},
        origin_order: {},
        origin_serial: 0,
        damage_elements: {},
        damage_input_serial: 0,
    }
}

function parentRoot(nodes, node, seen) {
    const expected = parentKinds.get(node.source_type)
    if (!expected) return { status: 'unsupported-source-type', source_type: node.source_type }
    if (node.parent === '0') return { status: 'missing-parent' }
    const parent = nodes[node.parent]
    if (!parent) return { status: 'missing-parent', index: node.parent }
    if (parent.kind !== expected) return { status: 'parent-kind-mismatch', index: node.parent }
    return root(nodes, parent, seen)
}

function root(nodes, first, seen = new Set()) {
    let node = first
    // Iterative traversal supports delayed parents without a recursion limit.
    while (node) {
        if (seen.has(node.index)) return { status: 'cycle', index: node.index }
        seen.add(node.index)
        if (node.conflicted) return { status: 'index-conflict', index: node.index }
        // Once a child is injected with a known skill, that copied skill ID
        // does not change when an old ancestor leaves the bounded history.
        if (node.root) return { status: 'resolved', ...node.root }
        if (node.kind === 'skill' || node.kind === 'bullet')
            return { status: 'resolved', skill_id: node.skill_id, actor: node.actor, index: node.index }
        const expected = parentKinds.get(node.source_type)
        if (!expected) return { status: 'unsupported-source-type', source_type: node.source_type }
        const parent = nodes[node.parent]
        if (!parent) return { status: 'missing-parent', index: node.parent }
        if (parent.kind !== expected) return { status: 'parent-kind-mismatch', index: node.parent }
        node = parent
    }
    return { status: 'missing-parent' }
}

function identity(node) {
    if (node.kind === 'skill') return JSON.stringify([node.kind, node.actor, node.skill_id])
    if (node.kind === 'bullet') return JSON.stringify([node.kind, node.actor, node.uid, node.config_id, node.skill_id])
    return JSON.stringify([
        node.kind,
        node.uid,
        node.config_id,
        node.parent,
        node.source_type,
        node.source_id,
        node.declared_skill_id,
    ])
}

function remember(c, data, verify) {
    const run = activeRun(c),
        index = u64(verify?.battle_index)
    if (!run || index === '0') return
    const node = {
        ...data,
        index,
        parent: u64(verify?.related_index),
        source_type: verify?.source_type ?? 0,
        source_id: i64(verify?.source_id),
    }
    const previous = run.origin_nodes?.[index]
    if (previous && identity(previous) === identity(node)) return
    const nodes = { ...run.origin_nodes }
    if (previous) {
        if (!previous.conflicted) console.warn(`[npc-arena] Conflicting combat origin index ${index}`)
        nodes[index] = { ...previous, conflicted: true }
    } else {
        if (node.kind === 'element') {
            const resolved = parentRoot(nodes, node, new Set([index]))
            if (
                node.declared_skill_id !== undefined &&
                ['index-conflict', 'cycle', 'parent-kind-mismatch'].includes(resolved.status)
            ) {
                node.conflicted = true
                console.warn(`[npc-arena] Invalid lineage for declared combat origin ${index}`)
            } else if (
                node.declared_skill_id !== undefined &&
                resolved.status === 'resolved' &&
                resolved.skill_id !== node.declared_skill_id
            ) {
                node.conflicted = true
                console.warn(`[npc-arena] Conflicting declared skill for combat origin ${index}`)
            } else if (node.declared_skill_id !== undefined)
                node.root = { skill_id: node.declared_skill_id, actor: node.actor, index, via: 'source-param' }
            else if (resolved.status === 'resolved')
                node.root = { skill_id: resolved.skill_id, actor: resolved.actor, index: resolved.index }
        }
        nodes[index] = node
    }
    const order = { ...run.origin_order, [index]: (run.origin_serial ?? 0) + 1 }
    if (Object.keys(nodes).length > 4096) {
        const oldest = Object.keys(nodes).reduce((a, b) => ((order[a] ?? 0) <= (order[b] ?? 0) ? a : b))
        delete nodes[oldest]
        delete order[oldest]
    }
    c.state.combat.npcDuel = {
        ...run,
        origin_nodes: nodes,
        origin_order: order,
        origin_serial: (run.origin_serial ?? 0) + 1,
    }
}

export function recordArenaSkillOrigin(c, request) {
    if (!(request.skill?.skill_id > 0)) return
    remember(c, { kind: 'skill', actor: u64(request.unit_id), skill_id: request.skill.skill_id }, request.verify_info)
}

export function recordArenaBulletOrigin(c, actor, bullet) {
    remember(
        c,
        {
            kind: 'bullet',
            actor: u64(actor),
            uid: u64(bullet.bullet_id),
            config_id: bullet.config_id,
            skill_id: bullet.skill_id ?? 0,
        },
        bullet.verify_info,
    )
}

export function recordArenaElementOrigin(c, event) {
    if (![1, 7, 10].includes(event.op)) return
    const declared = arenaPackedSkillOrigin(event.buff?.source_behavior_id)
    const metadata = arenaElementMetadata(event.buff?.cfg_id ?? 0)
    const snapshotState = arenaObservedNoSnapshot(c, event, metadata)
    remember(
        c,
        {
            kind: 'element',
            uid: u64(event.uniqueId),
            config_id: event.buff?.cfg_id ?? 0,
            actor: u64(event.buff?.source_id),
            element_metadata_status: metadata.status,
            ...(snapshotState ? { snapshot_state: snapshotState } : {}),
            ...(metadata.status === 'resolved'
                ? {
                      element_type: metadata.type,
                      configured_snapshot: metadata.snapshot,
                  }
                : {}),
            ...(declared.status === 'resolved' ? { declared_skill_id: declared.skill_id } : {}),
        },
        event.verify_info,
    )
}

export function arenaElementOrigin(c, verify, sourceParam) {
    const run = activeRun(c)
    if (!run) return { status: 'not-in-arena' }
    const index = u64(verify?.battle_index),
        node = run.origin_nodes?.[index]
    if (node) return root(run.origin_nodes, node)
    const inherited = parentRoot(
        run.origin_nodes ?? {},
        {
            parent: u64(verify?.related_index),
            source_type: verify?.source_type ?? 0,
        },
        new Set(index === '0' ? [] : [index]),
    )
    const declared = arenaPackedSkillOrigin(sourceParam)
    if (declared.status !== 'resolved') return inherited
    if (inherited.status === 'resolved' && inherited.skill_id !== declared.skill_id)
        return { status: 'skill-source-conflict' }
    if (['index-conflict', 'cycle', 'parent-kind-mismatch'].includes(inherited.status)) return inherited
    return { ...declared, index, actor: '0' }
}
