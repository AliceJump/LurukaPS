import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
export function restoreMissingStamina(tables, state) {
    const attrs = state.player.attr_infos.attrs
    if (attrs.some((attr) => attr.attr_id === 3)) return false
    const initial = Number(tables.get('game').find((row) => row.title === 'STAMINA_ACCOUNT_INITAIL')?.value)
    ensure(Number.isSafeInteger(initial) && initial >= 0, 'Missing initial stamina configuration', ErrorCode.GameConfig)
    attrs.push({ attr_id: 3, attr_val: String(initial) })
    return true
}
// CBT3 MyPlayerData.GetCurrencyNum06025a45 reads attribute values for both
// ordinary coins (1,2) and paid/bonus stars (901,902). Keep the legacy basic
// wallet fields and resource attributes in lockstep for old saves and UI.
export function syncCurrencyMirrors(player) {
    if (!player.attr_infos?.attrs) return false
    const attrs = player.attr_infos.attrs,
        basic = player.basic_info
    let changed = false
    for (const [id, key] of [
        [1, 'diamond'],
        [2, 'gold'],
    ]) {
        const value = basic[key]
        if (value === undefined) continue
        ensure(Number.isSafeInteger(value) && value >= 0, 'Invalid currency balance', ErrorCode.InvalidLogic)
        const old = attrs.find((a) => a.attr_id === id),
            text = String(value)
        if (!old) {
            attrs.push({ attr_id: id, attr_val: text })
            changed = true
        } else if (old.attr_val !== text) {
            old.attr_val = text
            changed = true
        }
    }
    return changed
}
