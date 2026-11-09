// Liang's hyphenation (Frank Liang, "Word Hy-phen-a-tion by Com-put-er", 1983; TeX's \patterns and
// \hyphenation): a pattern is a letter string with a digit between letters; matching every pattern against the
// word framed by dots, the highest digit seen at each gap wins and odd digits allow a break there. Exceptions
// list whole words with their breaks. Patterns are compiled once into a trie of typed arrays: children of a node
// are one sorted slice of the edge arrays, built in one pass over the sorted patterns.

const NO_BREAKS = new Uint8Array(0)
const DOT = 0x2e
// Words whose breaks are kept, per pattern set; emptied when full, so a long-lived set stays bounded.
const CACHE_LIMIT = 8192

export class HyphenationPatterns {
	// Children of node n: edges [first[n], first[n] + count[n]), sorted by edgeChar.
	private readonly first: Int32Array
	private readonly count: Uint16Array
	private readonly edgeChar: Uint16Array
	private readonly edgeNode: Int32Array
	// Per node: where its pattern's digits start in `digits` (one per gap of the pattern, letters + 1), or -1.
	private readonly value: Int32Array
	private readonly digits: Uint8Array
	private readonly exceptions: Map<string, Uint8Array>
	private readonly cache = new Map<string, Uint8Array>()
	// Per gap of the framed word being matched (scratch).
	private gaps = new Uint8Array(64)

	// `patterns` and `exceptions`: space-separated, as TeX's \patterns and \hyphenation take them (exceptions with
	// hyphens at their breaks).
	constructor(patterns: string, exceptions = "") {
		const keys: string[] = []
		const values: Uint8Array[] = []
		let letters = 0

		for (const pattern of patterns.split(/\s+/)) {
			if (pattern.length === 0) continue

			let key = ""
			const digits: number[] = [0]

			for (let i = 0; i < pattern.length; i++) {
				const c = pattern.charCodeAt(i)

				if (c >= 0x30 && c <= 0x39) digits[digits.length - 1] = c - 0x30
				else {
					key += pattern[i]
					digits.push(0)
				}
			}

			keys.push(key)
			values.push(Uint8Array.from(digits))
			letters += key.length
		}

		const order = keys.map((_, index) => index).sort((a, b) => compare(keys[a] ?? "", keys[b] ?? ""))
		const sorted = order.map(index => keys[index] ?? "")
		const sortedValues = order.map(index => values[index] ?? NO_BREAKS)
		const nodes = letters + 1

		this.first = new Int32Array(nodes)
		this.count = new Uint16Array(nodes)
		this.edgeChar = new Uint16Array(nodes)
		this.edgeNode = new Int32Array(nodes)
		this.value = new Int32Array(nodes).fill(-1)
		this.digits = new Uint8Array(letters + sorted.length)

		const state = { nodes: 0, edges: 0, digits: 0 }

		this.build(sorted, sortedValues, 0, sorted.length, 0, state)
		this.exceptions = new Map()

		for (const word of exceptions.split(/\s+/)) {
			if (word.length === 0) continue

			const breaks: number[] = []
			let plain = ""

			for (const c of word) {
				if (c === "-") breaks.push(plain.length)
				else plain += c
			}

			this.exceptions.set(plain, Uint8Array.from(breaks))
		}
	}

	// Offsets k (0 < k < word.length) where `word` (lower case) may break before word[k], ascending. The array is
	// shared: callers must not change it.
	breaks(word: string): Uint8Array {
		const known = this.cache.get(word) ?? this.exceptions.get(word)

		if (known !== undefined) return known

		const found = this.match(word)

		if (this.cache.size >= CACHE_LIMIT) this.cache.clear()

		this.cache.set(word, found)

		return found
	}

	private match(word: string): Uint8Array {
		const length = word.length
		const framed = length + 2

		if (length < 2 || length > 0xfd) return NO_BREAKS
		if (this.gaps.length < framed + 1) this.gaps = new Uint8Array(framed * 2)

		const gaps = this.gaps

		gaps.fill(0, 0, framed + 1)

		for (let i = 0; i < framed; i++) {
			let node = 0

			for (let j = i; j < framed; j++) {
				node = this.child(node, j === 0 || j === framed - 1 ? DOT : word.charCodeAt(j - 1))

				if (node < 0) break

				const at = this.value[node] ?? -1

				if (at < 0) continue

				for (let k = 0; k <= j - i + 1; k++) {
					const digit = this.digits[at + k] ?? 0

					if (digit > (gaps[i + k] ?? 0)) gaps[i + k] = digit
				}
			}
		}

		let count = 0

		// Gap i + 1 of the framed word lies before word[i].
		for (let i = 1; i < length; i++) if (((gaps[i + 1] ?? 0) & 1) === 1) count++

		if (count === 0) return NO_BREAKS

		const out = new Uint8Array(count)

		count = 0

		for (let i = 1; i < length; i++) if (((gaps[i + 1] ?? 0) & 1) === 1) out[count++] = i

		return out
	}

	private child(node: number, c: number): number {
		const start = this.first[node] ?? 0
		const end = start + (this.count[node] ?? 0)
		const chars = this.edgeChar
		let low = start
		let high = end - 1

		while (low <= high) {
			const middle = (low + high) >>> 1
			const at = chars[middle] ?? 0

			if (at === c) return this.edgeNode[middle] ?? -1
			if (at < c) low = middle + 1
			else high = middle - 1
		}

		return -1
	}

	// The node for keys[lo, hi), which share their first `depth` characters; returns its index.
	private build(
		keys: readonly string[],
		values: readonly Uint8Array[],
		lo: number,
		hi: number,
		depth: number,
		state: { nodes: number; edges: number; digits: number }
	): number {
		const node = state.nodes++

		// Sorted, a key that is the shared prefix itself comes first; a repeated pattern keeps the larger digits.
		while (lo < hi && (keys[lo]?.length ?? 0) === depth) {
			const digits = values[lo] ?? NO_BREAKS
			const at = this.value[node] ?? -1

			if (at < 0) {
				this.value[node] = state.digits
				this.digits.set(digits, state.digits)
				state.digits += digits.length
			} else {
				for (let k = 0; k < digits.length; k++) this.digits[at + k] = Math.max(this.digits[at + k] ?? 0, digits[k] ?? 0)
			}

			lo++
		}

		let groups = 0

		for (let i = lo; i < hi; groups++) {
			const c = keys[i]?.charCodeAt(depth) ?? 0

			while (i < hi && keys[i]?.charCodeAt(depth) === c) i++
		}

		const first = state.edges

		this.first[node] = first
		this.count[node] = groups
		state.edges += groups

		for (let i = lo, edge = first; i < hi; edge++) {
			const c = keys[i]?.charCodeAt(depth) ?? 0
			let end = i

			while (end < hi && keys[end]?.charCodeAt(depth) === c) end++

			this.edgeChar[edge] = c
			this.edgeNode[edge] = this.build(keys, values, i, end, depth + 1, state)
			i = end
		}

		return node
	}
}

// Code unit order, as the trie's binary search compares.
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}
