const acquisitionDrafts = new WeakSet()
// Acquisition counters are distinct from current stock (HaveCommonItem).
// Old saves have no historical ledger; current owned stock is a proven lower bound.
export function ownedResourceCount(state, type, id) {
    if (type === 3)
        return (state.player?.sbag_infos?.items ?? []).reduce(
            (sum, item) => sum + (item.itemid === id ? item.itemnum : 0),
            0,
        )
    if (type === 13) return state.home?.inventory?.find((item) => item.build_id === id)?.total_num ?? 0
    return 0
}
export function acquiredResourceCount(state, type, id) {
    return Math.max(state.itemAcquisitionCounts?.[type + ':' + id] ?? 0, ownedResourceCount(state, type, id))
}
export function recordResourceAcquisition(state, type, id, count) {
    if (![3, 13].includes(type)) return
    const value = acquiredResourceCount(state, type, id)
    // Copy this small ledger at most once per draft, so a failed batch cannot
    // mutate an earlier pending state through a shallow transaction fork.
    if (!acquisitionDrafts.has(state)) {
        state.itemAcquisitionCounts = { ...state.itemAcquisitionCounts }
        acquisitionDrafts.add(state)
    }
    state.itemAcquisitionCounts[type + ':' + id] = Math.min(0xffffffff, value + count)
}
