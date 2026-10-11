import { temporaryHeroes, temporaryPets } from './trial-actors.js'
// GUID bit layouts are not an ownership check: older pet saves can still use
// small GUIDs, and a summon may belong to either a player pet or an enemy.
export function isPlayerDamageSource(state, source) {
    let id = String(source ?? '0')
    const seen = new Set()
    while (id !== '0' && !seen.has(id) && seen.size < 16) {
        seen.add(id)
        if (
            state.player.heros_info.heros.some((hero) => String(hero.guid) === id) ||
            state.pets.some((pet) => String(pet.guid) === id) ||
            temporaryHeroes(state).some((hero) => String(hero.guid) === id) ||
            temporaryPets(state).some((pet) => String(pet.guid) === id)
        )
            return true
        id = String(state.combat?.summons?.[id]?.owner_id ?? state.combat?.entities?.[id]?.owner_id ?? '0')
    }
    return false
}
