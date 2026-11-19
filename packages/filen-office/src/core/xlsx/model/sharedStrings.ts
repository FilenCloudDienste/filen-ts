import type { XlsxRichRun, XlsxSharedStrings } from "./types"

// Entries pooled into one string each: a large table costs a few strings and an offset array, not a string per
// entry. text() slices (V8 shares the pool's characters for longer slices).
export const POOL_ENTRIES = 4096
const POOL_SHIFT = 12

// Parses a rich entry's runs from its <si> bytes (read/sharedStrings.ts), so this module needs no parser.
export type RunsParser = (si: Uint8Array) => readonly XlsxRichRun[] | null

// The rich source entries' <si> bytes, back to back in one pool: entry indexes ascending, each with the end of its
// bytes in the pool (an entry starts where the previous one ends). One buffer, not a typed array per entry.
export type RichSource = {
	readonly pool: Uint8Array
	readonly indexes: Uint32Array
	readonly ends: Uint32Array
}

const NO_RICH: RichSource = { pool: new Uint8Array(0), indexes: new Uint32Array(0), ends: new Uint32Array(0) }

export class SharedStrings implements XlsxSharedStrings {
	readonly sourceCount: number
	readonly sourceLength: number
	referenceDelta = 0
	private readonly pools: readonly string[]
	// Start of each entry in its pool.
	private readonly starts: Uint32Array
	// <si> bytes of the rich source entries, parsed on demand.
	private readonly richSource: RichSource
	private readonly parseRuns: RunsParser
	private readonly richParsed = new Map<number, readonly XlsxRichRun[] | null>()
	private readonly appended: string[] = []
	private readonly appendedRuns = new Map<number, readonly XlsxRichRun[]>()
	private readonly appendedPlain = new Map<string, number>()
	// Open-addressed hash of the plain source entries (index + 1), built on the first find.
	private table: Int32Array | null = null

	constructor(
		sourceCount: number,
		pools: readonly string[],
		starts: Uint32Array,
		length: number,
		richSource: RichSource,
		parseRuns: RunsParser
	) {
		this.sourceCount = sourceCount
		this.sourceLength = length
		this.pools = pools
		this.starts = starts
		this.richSource = richSource
		this.parseRuns = parseRuns
	}

	static empty(parseRuns: RunsParser): SharedStrings {
		return new SharedStrings(-1, [], new Uint32Array(0), 0, NO_RICH, parseRuns)
	}

	get length(): number {
		return this.sourceLength + this.appended.length
	}

	// Whether the source has a sharedStrings part (count -1: none, or no count attribute).
	get hasSourceCount(): boolean {
		return this.sourceCount >= 0
	}

	text(index: number): string {
		if (index < 0) return ""
		if (index >= this.sourceLength) return this.appended[index - this.sourceLength] ?? ""

		const pool = this.pools[index >>> POOL_SHIFT] ?? ""
		const next = index + 1

		return pool.slice(
			this.starts[index] ?? 0,
			(next & (POOL_ENTRIES - 1)) === 0 || next === this.sourceLength ? pool.length : (this.starts[next] ?? 0)
		)
	}

	isRich(index: number): boolean {
		return index < this.sourceLength ? this.richSlot(index) >= 0 : this.appendedRuns.has(index)
	}

	runs(index: number): readonly XlsxRichRun[] | null {
		if (index >= this.sourceLength) return this.appendedRuns.get(index) ?? null

		let runs = this.richParsed.get(index)

		if (runs === undefined) {
			const slot = this.richSlot(index)

			if (slot < 0) return null

			const { pool, ends } = this.richSource

			runs = this.parseRuns(pool.subarray(slot === 0 ? 0 : (ends[slot - 1] ?? 0), ends[slot] ?? 0))
			this.richParsed.set(index, runs)
		}

		return runs
	}

	find(text: string): number {
		const appended = this.appendedPlain.get(text)

		if (appended !== undefined) return appended

		const table = (this.table ??= this.buildTable())
		const mask = table.length - 1

		for (let slot = hashString(text) & mask; ; slot = (slot + 1) & mask) {
			const entry = table[slot] ?? 0

			if (entry === 0) return -1
			if (this.text(entry - 1) === text) return entry - 1
		}
	}

	append(text: string, runs?: readonly XlsxRichRun[]): number {
		if (runs === undefined || runs.length === 0) {
			const existing = this.appendedPlain.get(text)

			if (existing !== undefined) return existing
		}

		const index = this.sourceLength + this.appended.length

		this.appended.push(text)

		if (runs !== undefined && runs.length > 0) this.appendedRuns.set(index, runs)
		else this.appendedPlain.set(text, index)

		return index
	}

	adjustReferences(delta: number): void {
		this.referenceDelta += delta
	}

	// Position of a source entry in the rich source, or -1 when it is plain.
	private richSlot(index: number): number {
		const indexes = this.richSource.indexes
		let low = 0
		let high = indexes.length - 1

		while (low <= high) {
			const middle = (low + high) >>> 1
			const value = indexes[middle] ?? 0

			if (value === index) return middle
			if (value < index) low = middle + 1
			else high = middle - 1
		}

		return -1
	}

	private buildTable(): Int32Array {
		let size = 16

		while (size < this.sourceLength * 2) size *= 2

		const table = new Int32Array(size)
		const mask = size - 1
		const richIndexes = this.richSource.indexes
		let nextRich = 0

		for (let index = 0; index < this.sourceLength; index++) {
			if (nextRich < richIndexes.length && richIndexes[nextRich] === index) {
				nextRich++

				continue
			}

			const pool = this.pools[index >>> POOL_SHIFT] ?? ""
			const next = index + 1
			const start = this.starts[index] ?? 0
			const end = (next & (POOL_ENTRIES - 1)) === 0 || next === this.sourceLength ? pool.length : (this.starts[next] ?? 0)
			let hash = 0x811c9dc5

			for (let k = start; k < end; k++) hash = Math.imul(hash ^ pool.charCodeAt(k), 0x01000193)

			let slot = hash & mask

			while ((table[slot] ?? 0) !== 0) {
				// The first of equal entries wins, as a reader looking it up would find it.
				if (
					this.text((table[slot] ?? 0) - 1).length === end - start &&
					this.text((table[slot] ?? 0) - 1) === pool.slice(start, end)
				)
					break

				slot = (slot + 1) & mask
			}

			if ((table[slot] ?? 0) === 0) table[slot] = index + 1
		}

		return table
	}

	estimateBytes(): number {
		const rich = this.richSource
		let bytes =
			this.starts.byteLength + (this.table?.byteLength ?? 0) + rich.pool.byteLength + rich.indexes.byteLength + rich.ends.byteLength

		for (const pool of this.pools) bytes += pool.length * 2

		for (const text of this.appended) bytes += text.length * 2 + 32

		return bytes
	}
}

function hashString(text: string): number {
	let hash = 0x811c9dc5

	for (let k = 0; k < text.length; k++) hash = Math.imul(hash ^ text.charCodeAt(k), 0x01000193)

	return hash
}
