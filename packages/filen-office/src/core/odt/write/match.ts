// Matching two sequences of block keys.

// Longest common subsequence of two key arrays, past their common head and tail; a middle too large to compare
// cell by cell is matched greedily, each block to the next equal key at most 64 blocks ahead.
export function matchBlocks(a: readonly string[], b: readonly string[]): Int32Array {
	const out = new Int32Array(a.length).fill(-1)
	let head = 0

	while (head < a.length && head < b.length && a[head] === b[head]) {
		out[head] = head
		head++
	}

	let tail = 0

	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
		out[a.length - 1 - tail] = b.length - 1 - tail
		tail++
	}

	const n = a.length - head - tail
	const m = b.length - head - tail

	if (n === 0 || m === 0) return out

	if (n * m > 4_000_000) {
		// Too large to compare cell by cell: each source block takes the next edited block with its key (a local edit
		// leaves the rest in order, matched).
		const positions = new Map<string, number[]>()

		for (let j = m - 1; j >= 0; j--) {
			const key = b[head + j] ?? ""
			const list = positions.get(key)

			if (list === undefined) positions.set(key, [head + j])
			else list.push(head + j)
		}

		let last = head - 1

		for (let i = 0; i < n; i++) {
			const list = positions.get(a[head + i] ?? "")

			while (list !== undefined && list.length > 0 && (list[list.length - 1] ?? 0) <= last) list.pop()

			const next = list?.[list.length - 1]

			// Never jump far ahead past unmatched blocks: a block repeated later would otherwise swallow the edit's span.
			if (next !== undefined && next - last <= 64) {
				out[head + i] = next
				last = next
				list?.pop()
			}
		}

		return out
	}

	const table = new Uint32Array((n + 1) * (m + 1))

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * (m + 1) + j] =
				a[head + i] === b[head + j]
					? (table[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
					: Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + j + 1] ?? 0)
		}
	}

	for (let i = 0, j = 0; i < n && j < m;) {
		if (a[head + i] === b[head + j]) {
			out[head + i] = head + j
			i++
			j++
		} else if ((table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + j + 1] ?? 0)) i++
		else j++
	}

	return out
}
