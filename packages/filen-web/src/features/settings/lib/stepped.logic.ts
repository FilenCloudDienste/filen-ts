// The item `step` places from `current` in a sidebar's order, for a previous/next key: null past either end. With no
// current item (none open, or one the list no longer holds), stepping starts at the first or the last.
export function steppedItem<T>(items: readonly T[], current: T | null, step: 1 | -1): T | null {
	const index = current === null ? -1 : items.indexOf(current)
	const next = index === -1 ? (step === 1 ? 0 : items.length - 1) : index + step

	return items[next] ?? null
}
