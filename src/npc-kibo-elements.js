import fs from 'node:fs'

const catalog = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-elements.json', import.meta.url), 'utf8'))

export function arenaElementMetadata(id) {
    if (catalog.conflicts[id]) return { status: 'ambiguous', id }
    const row = catalog.elements[id]
    return row ? { status: 'resolved', id, ...row.config } : { status: 'unavailable', id }
}

// These are configured possibilities. Runtime verify/parent links must still
// prove which injection executed; this lookup cannot establish inheritance.
export function arenaConfiguredInjections(parentId, childId) {
    const parent = arenaElementMetadata(parentId),
        child = arenaElementMetadata(childId)
    if (parent.status !== 'resolved' || child.status !== 'resolved')
        return { status: 'configuration-unavailable', parent, child, paths: [] }
    const paths = parent.injections.filter((row) => row.status === 'resolved' && row.config_id === Number(childId))
    return { status: paths.length ? 'configured' : 'not-listed', paths }
}

export function arenaObservedIndependentInjection(c, event) {
    // WeatherControlElement.InjectElementsToEntity creates source_type6,
    // sets a parent UID, and leaves snapshot inheritance unset. A configured
    // edge alone is insufficient; match both observed identity and source.
    if (event.verify_info?.source_type !== 6 || !event.parentUniqueId || event.parentUniqueId === '0') return null
    // This method constructs a fresh verify struct with type6 only and calls
    // Parse(config, skillId:0, verify), without a packed skill source.
    if (
        String(event.verify_info.related_index ?? '0') !== '0' ||
        String(event.verify_info.source_id ?? '0') !== '0' ||
        String(event.buff?.source_behavior_id ?? '0') !== '0'
    )
        return null
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id || run.result || run.entities_sent === false) return null
    const parents = Object.values(run.origin_nodes ?? {}).filter(
        (node) => node.kind === 'element' && node.uid === String(event.parentUniqueId),
    )
    if (!parents.length || parents.some((node) => node.conflicted)) return null
    const configs = new Set(parents.map((node) => node.config_id))
    if (configs.size !== 1) return null
    const parent = arenaElementMetadata(parents[0].config_id)
    if (parent.status !== 'resolved' || parent.type !== 'ConfigTWeatherControlElementParams') return null
    const relation = arenaConfiguredInjections(parent.id, event.buff?.cfg_id)
    if (relation.status !== 'configured' || relation.paths.some((path) => path.policy !== 'own')) return null
    return {
        policy: 'own',
        parent: String(event.parentUniqueId),
        parent_config: parent.id,
        paths: relation.paths.map((path) => path.path),
        source_type: 6,
    }
}

export function arenaObservedNoSnapshot(c, event, metadata = arenaElementMetadata(event.buff?.cfg_id ?? 0)) {
    if (event.op !== 1 || metadata.status !== 'resolved') return null
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id || run.result || run.entities_sent === false) return null
    const type = event.verify_info?.source_type ?? 0,
        parentUid = String(event.parentUniqueId ?? '0')
    if (parentUid === '0' && [1, 3].includes(type) && !metadata.snapshot) {
        const parent = run.origin_nodes?.[String(event.verify_info?.related_index ?? '0')]
        if (parent && (parent.conflicted || parent.kind !== (type === 1 ? 'skill' : 'bullet'))) return null
        return { mode: 'none', key: '0', via: 'direct-config', source_type: type }
    }
    if (type !== 2) return null
    const trigger = arenaObservedTriggerInjection(c, event, metadata)
    if (trigger?.mode === 'none') return trigger
    const parent = run.origin_nodes?.[String(event.verify_info?.related_index ?? '0')]
    if (!parent || parent.kind !== 'element' || parent.conflicted || parent.snapshot_state?.mode !== 'none') return null
    if (parentUid !== '0' && parent.uid !== parentUid) return null
    const parentMetadata = arenaElementMetadata(parent.config_id)
    if (parentMetadata.status !== 'resolved' || parentMetadata.type !== 'ConfigTBuffElementParams') return null
    const declared = BigInt(event.buff?.source_behavior_id ?? '0')
    if (declared !== 0n && declared >> 32n !== 3n) return null
    const relation = arenaConfiguredInjections(parent.config_id, metadata.id)
    if (relation.status !== 'configured') return null
    const paths = relation.paths.filter((path) => {
        const noParentUid = path.path.startsWith('notDelElementDataList[') || path.path.includes('.NoDelElements[')
        return path.policy === 'parent-after-parse' && (parentUid === '0' ? noParentUid : !noParentUid)
    })
    if (!paths.length) return null
    return {
        mode: 'none',
        via: 'buff-after-parse',
        parent: parent.uid,
        parent_index: parent.index,
        parent_config: parent.config_id,
        paths: paths.map((path) => path.path),
        source_type: 2,
        ...(parent.snapshot_state.key !== undefined ? { key: parent.snapshot_state.key } : {}),
    }
}

export function arenaObservedTriggerInjection(c, event, metadata = arenaElementMetadata(event.buff?.cfg_id ?? 0)) {
    if (event.op !== 1 || metadata.status !== 'resolved' || event.verify_info?.source_type !== 2) return null
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id || run.result || run.entities_sent === false) return null
    const parent = run.origin_nodes?.[String(event.verify_info.related_index ?? '0')]
    if (!parent || parent.kind !== 'element' || parent.conflicted || parent.uid !== String(event.parentUniqueId ?? '0'))
        return null
    // A proven direct non-snapshot parent retains the reset snapshot key0.
    // ParseBase/GetElementIndex assign a nonzero UID to every own snapshot,
    // so key0 has no owning snapshot, even though the child inherits it.
    if (parent.snapshot_state?.mode !== 'none' || parent.snapshot_state.key !== '0') return null
    const parentMetadata = arenaElementMetadata(parent.config_id)
    if (parentMetadata.status !== 'resolved' || parentMetadata.type !== 'ConfigTTriggerElementParams') return null
    const declared = BigInt(event.buff?.source_behavior_id ?? '0')
    if (declared !== 0n && declared >> 32n !== 3n) return null
    const relation = arenaConfiguredInjections(parent.config_id, metadata.id)
    if (relation.status !== 'configured' || relation.paths.some((path) => path.policy !== 'parent-before-parse'))
        return null
    return {
        policy: 'parent-before-parse',
        via: 'trigger-before-parse',
        key: '0',
        mode: metadata.snapshot ? 'inherited' : 'none',
        parent: parent.uid,
        parent_index: parent.index,
        parent_config: parent.config_id,
        paths: relation.paths.map((path) => path.path),
        source_type: 2,
    }
}
