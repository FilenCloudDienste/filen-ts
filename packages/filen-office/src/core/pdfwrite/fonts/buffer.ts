// The glyph buffer one run is shaped in: parallel typed arrays in logical order, grown on demand and reused
// across runs, so shaping a fragment allocates nothing once warm.

export const AttachType = { NONE: 0, MARK: 1, CURSIVE: 2 } as const

// What GSUB did to a glyph.
export const GlyphFlag = { SUBSTITUTED: 1, LIGATED: 2, MULTIPLIED: 4 } as const

// How far one run may grow and how much lookup work it may take, from its length after cmap: HarfBuzz's
// buffer limits (hb-buffer.hh: HB_BUFFER_MAX_LEN_FACTOR 64 and HB_BUFFER_MAX_LEN_MIN 16384,
// HB_BUFFER_MAX_OPS_FACTOR 1024 and HB_BUFFER_MAX_OPS_MIN 16384). A run past either is drawn unshaped.
const MAX_LENGTH_FACTOR = 64
const MAX_LENGTH_MIN = 16384
const MAX_OPS_FACTOR = 1024
const MAX_OPS_MIN = 16384
// Moving glyphs costs one operation per this many moved, so shifting work stays linear in the run.
const MOVES_PER_OP = 32

// A run went past the shaping limits (a font whose lookups multiply glyphs without end, or loop).
export class ShapingLimitError extends Error {
	constructor() {
		super("The run went past the shaping limits")
	}
}

export class GlyphBuffer {
	length = 0
	// Shaping limits of the run being shaped (none outside shaping).
	maxLength = Number.POSITIVE_INFINITY
	opsLeft = Number.POSITIVE_INFINITY
	capacity = 0
	glyph = new Uint16Array(0)
	// Source code point of the glyph (the first one for a ligature); 0 for glyphs a lookup inserted.
	cp = new Uint32Array(0)
	// UTF-16 offset of the cluster start in the shaped text.
	cluster = new Uint32Array(0)
	// Feature bits that apply to the glyph.
	mask = new Uint32Array(0)
	// GDEF class (or the one derived from Unicode when the font has none).
	glyphClass = new Uint8Array(0)
	// GlyphFlag bits.
	flags = new Uint8Array(0)
	// Ligature id and component index, for mark-to-ligature attachment.
	ligId = new Uint8Array(0)
	ligComp = new Uint8Array(0)
	// Shaper data: Indic category / Arabic action, Indic position.
	category = new Uint8Array(0)
	position = new Uint8Array(0)
	syllable = new Uint16Array(0)
	// Positions in font units.
	xAdvance = new Int32Array(0)
	yAdvance = new Int32Array(0)
	xOffset = new Int32Array(0)
	yOffset = new Int32Array(0)
	// Relative index of the glyph this one is attached to (0: none) and how.
	attach = new Int32Array(0)
	attachType = new Uint8Array(0)

	// Sets the limits for shaping the current contents.
	limit(): void {
		this.maxLength = Math.max(MAX_LENGTH_MIN, this.length * MAX_LENGTH_FACTOR)
		this.opsLeft = Math.max(MAX_OPS_MIN, this.length * MAX_OPS_FACTOR)
	}

	unlimit(): void {
		this.maxLength = Number.POSITIVE_INFINITY
		this.opsLeft = Number.POSITIVE_INFINITY
	}

	// Charges `units` operations to the run.
	spend(units: number): void {
		this.opsLeft -= units

		if (this.opsLeft < 0) throw new ShapingLimitError()
	}

	reset(length: number): void {
		this.ensure(length)
		this.length = length
		this.mask.fill(0, 0, length)
		this.flags.fill(0, 0, length)
		this.ligId.fill(0, 0, length)
		this.ligComp.fill(0, 0, length)
		this.category.fill(0, 0, length)
		this.position.fill(0, 0, length)
		this.syllable.fill(0, 0, length)
		this.clearPositions()
	}

	clearPositions(): void {
		const n = this.length

		this.xAdvance.fill(0, 0, n)
		this.yAdvance.fill(0, 0, n)
		this.xOffset.fill(0, 0, n)
		this.yOffset.fill(0, 0, n)
		this.attach.fill(0, 0, n)
		this.attachType.fill(0, 0, n)
	}

	ensure(capacity: number): void {
		if (capacity > this.maxLength) throw new ShapingLimitError()
		if (capacity <= this.capacity) return

		const size = Math.max(capacity, this.capacity * 2, 32)

		this.glyph = grow(this.glyph, new Uint16Array(size))
		this.cp = grow(this.cp, new Uint32Array(size))
		this.cluster = grow(this.cluster, new Uint32Array(size))
		this.mask = grow(this.mask, new Uint32Array(size))
		this.glyphClass = grow(this.glyphClass, new Uint8Array(size))
		this.flags = grow(this.flags, new Uint8Array(size))
		this.ligId = grow(this.ligId, new Uint8Array(size))
		this.ligComp = grow(this.ligComp, new Uint8Array(size))
		this.category = grow(this.category, new Uint8Array(size))
		this.position = grow(this.position, new Uint8Array(size))
		this.syllable = grow(this.syllable, new Uint16Array(size))
		this.xAdvance = grow(this.xAdvance, new Int32Array(size))
		this.yAdvance = grow(this.yAdvance, new Int32Array(size))
		this.xOffset = grow(this.xOffset, new Int32Array(size))
		this.yOffset = grow(this.yOffset, new Int32Array(size))
		this.attach = grow(this.attach, new Int32Array(size))
		this.attachType = grow(this.attachType, new Uint8Array(size))
		this.capacity = size
	}

	// Replaces `count` glyphs at `at` with `glyphs`, the new ones inheriting the first replaced glyph's data.
	replace(at: number, count: number, glyphs: ArrayLike<number>): void {
		const delta = glyphs.length - count

		if (delta !== 0) this.shift(at + count, delta)

		for (let k = 0; k < glyphs.length; k++) {
			const to = at + k

			this.glyph[to] = glyphs[k] ?? 0

			if (k >= count) this.copyData(at, to)
		}
	}

	// Copies everything but the glyph id from `from` to `to`.
	copyData(from: number, to: number): void {
		if (from === to) return

		this.cp[to] = this.cp[from] ?? 0
		this.cluster[to] = this.cluster[from] ?? 0
		this.mask[to] = this.mask[from] ?? 0
		this.glyphClass[to] = this.glyphClass[from] ?? 0
		this.flags[to] = this.flags[from] ?? 0
		this.ligId[to] = this.ligId[from] ?? 0
		this.ligComp[to] = this.ligComp[from] ?? 0
		this.category[to] = this.category[from] ?? 0
		this.position[to] = this.position[from] ?? 0
		this.syllable[to] = this.syllable[from] ?? 0
	}

	// Moves the glyph at `from` to `to` (to < from or to > from), shifting the ones between.
	move(from: number, to: number): void {
		if (from === to) return

		this.spend(1 + Math.floor(Math.abs(to - from) / MOVES_PER_OP))

		const saved = this.save(from)

		if (to < from) {
			for (let k = from; k > to; k--) this.copyAll(k - 1, k)
		} else {
			for (let k = from; k < to; k++) this.copyAll(k + 1, k)
		}

		this.restore(saved, to)
	}

	remove(at: number): void {
		this.shift(at + 1, -1)
	}

	// Removes every glyph `drop` picks in one pass. Attachments (relative indices) keep their parents; a removed
	// first glyph gives its cluster to the first glyph kept.
	removeWhere(drop: (i: number) => boolean): void {
		const n = this.length

		if (this.removedBefore.length < n + 1) this.removedBefore = new Uint32Array(n + 1)

		const removedBefore = this.removedBefore
		let removed = 0

		for (let i = 0; i < n; i++) {
			if (drop(i)) {
				removedBefore[i] = removed | DROPPED
				removed++
			} else {
				removedBefore[i] = removed
			}
		}

		removedBefore[n] = removed

		if (removed === 0) return

		const firstCluster = this.cluster[0] ?? 0
		const firstDropped = ((removedBefore[0] ?? 0) & DROPPED) !== 0
		let to = 0

		for (let i = 0; i < n; i++) {
			if (((removedBefore[i] ?? 0) & DROPPED) !== 0) continue

			const attach = this.attach[i] ?? 0

			if (attach !== 0) {
				const parent = Math.max(0, Math.min(n, i + attach))

				this.attach[i] = parent - ((removedBefore[parent] ?? 0) & ~DROPPED) - to
			}

			this.copyAll(i, to)
			to++
		}

		this.length = to

		if (firstDropped && to > 0) this.cluster[0] = Math.min(this.cluster[0] ?? 0, firstCluster)
	}

	// Reorders [start, start + order.length) so that slot k holds the glyph that was at start + order[k].
	permute(start: number, order: readonly number[]): void {
		const count = order.length
		const scratch = (this.scratch ??= new GlyphBuffer())

		this.spend(1 + Math.floor(count / MOVES_PER_OP))
		scratch.ensure(count)

		for (let k = 0; k < count; k++) copyEntry(this, start + (order[k] ?? k), scratch, k)
		for (let k = 0; k < count; k++) copyEntry(scratch, k, this, start + k)
	}

	// Appends glyph `from` of `source` with all its data.
	appendFrom(source: GlyphBuffer, from: number): void {
		this.ensure(this.length + 1)
		copyEntry(source, from, this, this.length)
		this.length++
	}

	// Exchanges contents with `other` (limits stay).
	swap(other: GlyphBuffer): void {
		const self = this as unknown as Record<Field, unknown>
		const them = other as unknown as Record<Field, unknown>

		for (const key of FIELDS) {
			const mine = self[key]

			self[key] = them[key]
			them[key] = mine
		}

		const length = this.length
		const capacity = this.capacity

		this.length = other.length
		this.capacity = other.capacity
		other.length = length
		other.capacity = capacity
	}

	private removedBefore = new Uint32Array(0)
	private scratch: GlyphBuffer | null = null

	// Reverses [start, end) in place.
	reverse(start: number, end: number): void {
		for (let a = start, b = end - 1; a < b; a++, b--) {
			const saved = this.save(a)

			this.copyAll(b, a)
			this.restore(saved, b)
		}
	}

	// Sets the cluster of [start, end) to the smallest one among them.
	mergeClusters(start: number, end: number): void {
		if (end - start < 2) return

		this.spend(Math.floor((end - start) / MOVES_PER_OP))

		let cluster = this.cluster[start] ?? 0

		for (let k = start + 1; k < end; k++) cluster = Math.min(cluster, this.cluster[k] ?? 0)

		this.cluster.fill(cluster, start, end)
	}

	private shift(from: number, delta: number): void {
		const n = this.length

		this.ensure(n + Math.max(0, delta))
		this.spend(1 + Math.floor(Math.max(0, n - from) / MOVES_PER_OP))

		const arrays = [
			this.glyph,
			this.cp,
			this.cluster,
			this.mask,
			this.glyphClass,
			this.flags,
			this.ligId,
			this.ligComp,
			this.category,
			this.position,
			this.syllable,
			this.xAdvance,
			this.yAdvance,
			this.xOffset,
			this.yOffset,
			this.attach,
			this.attachType
		]

		for (const array of arrays) array.copyWithin(from + delta, from, n)

		this.length = n + delta
	}

	private copyAll(from: number, to: number): void {
		this.glyph[to] = this.glyph[from] ?? 0
		this.copyData(from, to)
		this.xAdvance[to] = this.xAdvance[from] ?? 0
		this.yAdvance[to] = this.yAdvance[from] ?? 0
		this.xOffset[to] = this.xOffset[from] ?? 0
		this.yOffset[to] = this.yOffset[from] ?? 0
		this.attach[to] = this.attach[from] ?? 0
		this.attachType[to] = this.attachType[from] ?? 0
	}

	private save(at: number): number[] {
		return [
			this.glyph[at] ?? 0,
			this.cp[at] ?? 0,
			this.cluster[at] ?? 0,
			this.mask[at] ?? 0,
			this.glyphClass[at] ?? 0,
			this.flags[at] ?? 0,
			this.ligId[at] ?? 0,
			this.ligComp[at] ?? 0,
			this.category[at] ?? 0,
			this.position[at] ?? 0,
			this.syllable[at] ?? 0
		]
	}

	private restore(saved: readonly number[], at: number): void {
		this.glyph[at] = saved[0] ?? 0
		this.cp[at] = saved[1] ?? 0
		this.cluster[at] = saved[2] ?? 0
		this.mask[at] = saved[3] ?? 0
		this.glyphClass[at] = saved[4] ?? 0
		this.flags[at] = saved[5] ?? 0
		this.ligId[at] = saved[6] ?? 0
		this.ligComp[at] = saved[7] ?? 0
		this.category[at] = saved[8] ?? 0
		this.position[at] = saved[9] ?? 0
		this.syllable[at] = saved[10] ?? 0
	}
}

const DROPPED = 0x80000000

const FIELDS = [
	"glyph",
	"cp",
	"cluster",
	"mask",
	"glyphClass",
	"flags",
	"ligId",
	"ligComp",
	"category",
	"position",
	"syllable",
	"xAdvance",
	"yAdvance",
	"xOffset",
	"yOffset",
	"attach",
	"attachType"
] as const

type Field = (typeof FIELDS)[number]

function copyEntry(source: GlyphBuffer, from: number, target: GlyphBuffer, to: number): void {
	target.glyph[to] = source.glyph[from] ?? 0
	target.cp[to] = source.cp[from] ?? 0
	target.cluster[to] = source.cluster[from] ?? 0
	target.mask[to] = source.mask[from] ?? 0
	target.glyphClass[to] = source.glyphClass[from] ?? 0
	target.flags[to] = source.flags[from] ?? 0
	target.ligId[to] = source.ligId[from] ?? 0
	target.ligComp[to] = source.ligComp[from] ?? 0
	target.category[to] = source.category[from] ?? 0
	target.position[to] = source.position[from] ?? 0
	target.syllable[to] = source.syllable[from] ?? 0
	target.xAdvance[to] = source.xAdvance[from] ?? 0
	target.yAdvance[to] = source.yAdvance[from] ?? 0
	target.xOffset[to] = source.xOffset[from] ?? 0
	target.yOffset[to] = source.yOffset[from] ?? 0
	target.attach[to] = source.attach[from] ?? 0
	target.attachType[to] = source.attachType[from] ?? 0
}

function grow<T extends Uint8Array | Uint16Array | Uint32Array | Int32Array>(old: T, next: T): T {
	next.set(old)

	return next
}
