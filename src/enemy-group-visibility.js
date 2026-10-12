// CBT3 EnemyGroupSync reads world_indexes as VisibleEnemies, separately
// from the full monster attribute roster. Preserve original slot indices.
export function visibleEnemySlots(monsters, entities) {
    return monsters.flatMap((monster, slot) => {
        const entity = entities?.[monster.uid] ?? monster
        return entity.hp > 0 && entity.alive_state !== 1 && !entity.captured ? [slot] : []
    })
}
