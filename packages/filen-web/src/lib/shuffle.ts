// A permutation of [0, length) with `currentIndex` pinned first when it is in range (so toggling
// shuffle on mid-track keeps the current track playing), the rest Fisher–Yates shuffled. `random` is
// injectable purely so tests can assert current-first placement and permutation-completeness
// deterministically; production passes Math.random. A currentIndex outside the range yields a full,
// unanchored shuffle (used when a loop pass reshuffles with no track to preserve).
export function buildShuffleOrder(length: number, currentIndex: number, random: () => number = Math.random): number[] {
	if (length <= 0) {
		return []
	}

	const indices: number[] = []

	for (let i = 0; i < length; i++) {
		indices.push(i)
	}

	const anchored = currentIndex >= 0 && currentIndex < length
	const pool = anchored ? indices.filter(i => i !== currentIndex) : indices

	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		const a = pool[i] ?? 0
		const b = pool[j] ?? 0

		pool[i] = b
		pool[j] = a
	}

	return anchored ? [currentIndex, ...pool] : pool
}

// The order of a fresh shuffle lap under loop "all": the track that just finished never comes first (it would replay
// at once), so the others are shuffled and it goes to a random later slot.
export function buildLapShuffleOrder(length: number, finishedIndex: number, random: () => number = Math.random): number[] {
	if (length <= 1 || finishedIndex < 0 || finishedIndex >= length) {
		return buildShuffleOrder(length, -1, random)
	}

	const order = buildShuffleOrder(length, finishedIndex, random).slice(1)

	order.splice(1 + Math.floor(random() * order.length), 0, finishedIndex)

	return order
}
