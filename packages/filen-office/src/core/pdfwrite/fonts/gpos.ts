import { LookupApplier } from "./apply"
import { AttachType } from "./buffer"
import { GlyphClass, LookupFlag, classOf, coverageIndex } from "./otl"
import { isDefaultIgnorable } from "./unicode"

// GPOS lookup types 1-8 (OpenType 1.9 "GPOS — Glyph Positioning Table"), and type 9 extension subtables, which
// LayoutTable (otl.ts) resolves to the type they wrap. Device tables and contour-point anchors are not used: PDF
// text is not hinted. Attachments are resolved to origins by resolveOrigins. The cursive attachment convention
// (which glyph takes the cross-stream offset) is HarfBuzz's
// (src/OT/Layout/GPOS/CursivePosFormat1.hh, HarfBuzz 14.6.0, "Old MIT" licence, see THIRD_PARTY_NOTICES.md).

export class PositioningApplier extends LookupApplier {
	// The run's direction, for cursive attachment.
	rtl = false

	protected isReverse(): boolean {
		return false
	}

	protected applySubtable(type: number, offset: number, i: number): number {
		switch (type) {
			case 1:
				return this.single(offset, i)
			case 2:
				return this.pair(offset, i)
			case 3:
				return this.cursive(offset, i)
			case 4:
				return this.markToBase(offset, i)
			case 5:
				return this.markToLigature(offset, i)
			case 6:
				return this.markToMark(offset, i)
			case 7:
				return this.applyContext(offset, i, false)
			case 8:
				return this.applyContext(offset, i, true)
			default:
				return -1
		}
	}

	// Adds a ValueRecord at `at` with `format` to glyph i.
	private value(format: number, at: number, i: number): void {
		const view = this.view
		const buffer = this.buffer
		let p = at

		if (format & 1) {
			buffer.xOffset[i] = (buffer.xOffset[i] ?? 0) + view.getInt16(p)
			p += 2
		}

		if (format & 2) {
			buffer.yOffset[i] = (buffer.yOffset[i] ?? 0) + view.getInt16(p)
			p += 2
		}

		if (format & 4) {
			buffer.xAdvance[i] = (buffer.xAdvance[i] ?? 0) + view.getInt16(p)
			p += 2
		}

		if (format & 8) buffer.yAdvance[i] = (buffer.yAdvance[i] ?? 0) + view.getInt16(p)
	}

	private single(offset: number, i: number): number {
		const view = this.view
		const covered = coverageIndex(view, offset + view.getUint16(offset + 2), this.buffer.glyph[i] ?? 0)

		if (covered < 0) return -1

		const format = view.getUint16(offset)
		const valueFormat = view.getUint16(offset + 4)

		if (format === 1) this.value(valueFormat, offset + 6, i)
		else if (format === 2 && covered < view.getUint16(offset + 6))
			this.value(valueFormat, offset + 8 + covered * valueSize(valueFormat), i)
		else return -1

		return i + 1
	}

	private pair(offset: number, i: number): number {
		const view = this.view
		const buffer = this.buffer
		const first = buffer.glyph[i] ?? 0
		const covered = coverageIndex(view, offset + view.getUint16(offset + 2), first)

		if (covered < 0) return -1

		const j = this.step(i, 1)

		if (j < 0) return -1

		const second = buffer.glyph[j] ?? 0
		const format = view.getUint16(offset)
		const format1 = view.getUint16(offset + 4)
		const format2 = view.getUint16(offset + 6)
		const size1 = valueSize(format1)
		const size2 = valueSize(format2)

		if (format === 1) {
			if (covered >= view.getUint16(offset + 8)) return -1

			const set = offset + view.getUint16(offset + 10 + covered * 2)
			const count = view.getUint16(set)
			const record = 2 + size1 + size2
			let low = 0
			let high = count - 1

			while (low <= high) {
				const middle = (low + high) >>> 1
				const at = set + 2 + middle * record
				const glyph = view.getUint16(at)

				if (glyph === second) {
					this.value(format1, at + 2, i)
					this.value(format2, at + 2 + size1, j)

					return format2 !== 0 ? j + 1 : j
				}

				if (glyph < second) low = middle + 1
				else high = middle - 1
			}

			return -1
		}

		if (format !== 2) return -1

		const class1 = classOf(view, offset + view.getUint16(offset + 8), first)
		const class2 = classOf(view, offset + view.getUint16(offset + 10), second)
		const class1Count = view.getUint16(offset + 12)
		const class2Count = view.getUint16(offset + 14)

		if (class1 >= class1Count || class2 >= class2Count) return -1

		const at = offset + 16 + (class1 * class2Count + class2) * (size1 + size2)

		this.value(format1, at, i)
		this.value(format2, at + size1, j)

		return format2 !== 0 ? j + 1 : j
	}

	private anchor(at: number): readonly [number, number] {
		const view = this.view

		return [view.getInt16(at + 2), view.getInt16(at + 4)]
	}

	private cursive(offset: number, i: number): number {
		const view = this.view
		const buffer = this.buffer
		const coverage = offset + view.getUint16(offset + 2)
		const count = view.getUint16(offset + 4)
		const here = coverageIndex(view, coverage, buffer.glyph[i] ?? 0)

		if (here < 0 || here >= count) return -1

		const entryOffset = view.getUint16(offset + 6 + here * 4)

		if (entryOffset === 0) return -1

		const j = this.step(i, -1, false)

		if (j < 0) return -1

		const previous = coverageIndex(view, coverage, buffer.glyph[j] ?? 0)

		if (previous < 0 || previous >= count) return -1

		const exitOffset = view.getUint16(offset + 6 + previous * 4 + 2)

		if (exitOffset === 0) return -1

		const [exitX, exitY] = this.anchor(offset + exitOffset)
		const [entryX, entryY] = this.anchor(offset + entryOffset)

		// The main-direction adjustment, then the cross-direction offset of the child (HarfBuzz's convention).
		if (this.rtl) {
			const d = exitX + (buffer.xOffset[j] ?? 0)

			buffer.xAdvance[j] = (buffer.xAdvance[j] ?? 0) - d
			buffer.xOffset[j] = (buffer.xOffset[j] ?? 0) - d
			buffer.xAdvance[i] = entryX + (buffer.xOffset[i] ?? 0)
		} else {
			buffer.xAdvance[j] = exitX + (buffer.xOffset[j] ?? 0)

			const d = entryX + (buffer.xOffset[i] ?? 0)

			buffer.xAdvance[i] = (buffer.xAdvance[i] ?? 0) - d
			buffer.xOffset[i] = (buffer.xOffset[i] ?? 0) - d
		}

		let child = j
		let parent = i
		let yOffset = entryY - exitY

		if ((this.lookup.flag & LookupFlag.RIGHT_TO_LEFT) === 0) {
			child = i
			parent = j
			yOffset = -yOffset
		}

		// A parent already attached to the child would form a loop.
		if (buffer.attachType[parent] === AttachType.CURSIVE && parent + (buffer.attach[parent] ?? 0) === child) {
			buffer.attachType[parent] = AttachType.NONE
			buffer.attach[parent] = 0
		}

		buffer.attachType[child] = AttachType.CURSIVE
		buffer.attach[child] = parent - child
		buffer.yOffset[child] = yOffset

		return i + 1
	}

	// The previous glyph a mark attaches to: the first one back that is not a mark.
	private previousBase(i: number): number {
		const buffer = this.buffer

		let k = i - 1

		while (k >= 0 && buffer.glyphClass[k] === GlyphClass.MARK) k--

		this.visit(i - k)

		return k
	}

	private attachMark(i: number, base: number, markArray: number, markIndex: number, baseAnchor: number): number {
		const view = this.view
		const buffer = this.buffer
		const record = markArray + 2 + markIndex * 4
		const [markX, markY] = this.anchor(markArray + view.getUint16(record + 2))
		const [baseX, baseY] = this.anchor(baseAnchor)

		buffer.xOffset[i] = baseX - markX
		buffer.yOffset[i] = baseY - markY
		buffer.attachType[i] = AttachType.MARK
		buffer.attach[i] = base - i

		return i + 1
	}

	private markToBase(offset: number, i: number): number {
		const view = this.view
		const buffer = this.buffer
		const markIndex = coverageIndex(view, offset + view.getUint16(offset + 2), buffer.glyph[i] ?? 0)

		if (markIndex < 0) return -1

		const base = this.previousBase(i)

		if (base < 0) return -1

		const baseIndex = coverageIndex(view, offset + view.getUint16(offset + 4), buffer.glyph[base] ?? 0)

		if (baseIndex < 0) return -1

		const classCount = view.getUint16(offset + 6)
		const markArray = offset + view.getUint16(offset + 8)
		const baseArray = offset + view.getUint16(offset + 10)
		const markClass = view.getUint16(markArray + 2 + markIndex * 4)

		if (markClass >= classCount || baseIndex >= view.getUint16(baseArray)) return -1

		const anchorOffset = view.getUint16(baseArray + 2 + (baseIndex * classCount + markClass) * 2)

		if (anchorOffset === 0) return -1

		return this.attachMark(i, base, markArray, markIndex, baseArray + anchorOffset)
	}

	private markToLigature(offset: number, i: number): number {
		const view = this.view
		const buffer = this.buffer
		const markIndex = coverageIndex(view, offset + view.getUint16(offset + 2), buffer.glyph[i] ?? 0)

		if (markIndex < 0) return -1

		const base = this.previousBase(i)

		if (base < 0) return -1

		const ligatureIndex = coverageIndex(view, offset + view.getUint16(offset + 4), buffer.glyph[base] ?? 0)

		if (ligatureIndex < 0) return -1

		const classCount = view.getUint16(offset + 6)
		const markArray = offset + view.getUint16(offset + 8)
		const ligatureArray = offset + view.getUint16(offset + 10)
		const markClass = view.getUint16(markArray + 2 + markIndex * 4)

		if (markClass >= classCount || ligatureIndex >= view.getUint16(ligatureArray)) return -1

		const attach = ligatureArray + view.getUint16(ligatureArray + 2 + ligatureIndex * 2)
		const components = view.getUint16(attach)

		if (components === 0) return -1

		const ligId = buffer.ligId[base] ?? 0
		const markLigId = buffer.ligId[i] ?? 0
		const markComp = buffer.ligComp[i] ?? 0
		const component = ligId !== 0 && ligId === markLigId && markComp > 0 ? Math.min(components, markComp) - 1 : components - 1
		const anchorOffset = view.getUint16(attach + 2 + (component * classCount + markClass) * 2)

		if (anchorOffset === 0) return -1

		return this.attachMark(i, base, markArray, markIndex, attach + anchorOffset)
	}

	// The mark before `i` that mark-to-mark attaches to: marks the lookup's filter set or attachment class
	// excludes, and default ignorables, are stepped over; anything else stops the search.
	private previousMark(i: number): number {
		const buffer = this.buffer
		const flag = this.lookup.flag & ~(LookupFlag.IGNORE_BASE_GLYPHS | LookupFlag.IGNORE_LIGATURES | LookupFlag.IGNORE_MARKS)

		let found = -1
		let k = i - 1

		for (; k >= 0; k--) {
			if (isDefaultIgnorable(buffer.cp[k] ?? 0)) continue
			if (buffer.glyphClass[k] !== GlyphClass.MARK) break
			if (!this.ignoredByFlag(k, flag, this.lookup.markFilteringSet)) {
				found = k
				break
			}
		}

		this.visit(i - k)

		return found
	}

	private markToMark(offset: number, i: number): number {
		const view = this.view
		const buffer = this.buffer
		const markIndex = coverageIndex(view, offset + view.getUint16(offset + 2), buffer.glyph[i] ?? 0)

		if (markIndex < 0) return -1

		const previous = this.previousMark(i)

		if (previous < 0) return -1

		const id1 = buffer.ligId[i] ?? 0
		const id2 = buffer.ligId[previous] ?? 0
		const comp1 = buffer.ligComp[i] ?? 0
		const comp2 = buffer.ligComp[previous] ?? 0
		// Marks of one base, or of one ligature component, or where either mark is itself a ligature.
		const together = id1 === id2 ? id1 === 0 || comp1 === comp2 : (id1 > 0 && comp1 === 0) || (id2 > 0 && comp2 === 0)

		if (!together) return -1

		const mark2Index = coverageIndex(view, offset + view.getUint16(offset + 4), buffer.glyph[previous] ?? 0)

		if (mark2Index < 0) return -1

		const classCount = view.getUint16(offset + 6)
		const markArray = offset + view.getUint16(offset + 8)
		const mark2Array = offset + view.getUint16(offset + 10)
		const markClass = view.getUint16(markArray + 2 + markIndex * 4)

		if (markClass >= classCount || mark2Index >= view.getUint16(mark2Array)) return -1

		const anchorOffset = view.getUint16(mark2Array + 2 + (mark2Index * classCount + markClass) * 2)

		if (anchorOffset === 0) return -1

		return this.attachMark(i, previous, markArray, markIndex, mark2Array + anchorOffset)
	}
}

function valueSize(format: number): number {
	let size = 0

	for (let bit = format & 0xff; bit !== 0; bit >>>= 1) size += (bit & 1) * 2

	return size
}

// Turns attachments into absolute glyph origins (font units, x from the run's left edge) for glyphs in
// logical order. `rtl` runs are laid out from the right.
export function resolveOrigins(
	buffer: {
		readonly length: number
		xAdvance: Int32Array
		yAdvance: Int32Array
		xOffset: Int32Array
		yOffset: Int32Array
		attach: Int32Array
		attachType: Uint8Array
	},
	rtl: boolean,
	x: Float64Array,
	y: Float64Array
): number {
	const n = buffer.length
	let total = 0

	for (let i = 0; i < n; i++) total += buffer.xAdvance[i] ?? 0

	// Cursive chains: a child's y follows its parent's, resolved from the chain's root.
	const resolvedY = new Float64Array(n)
	const done = new Uint8Array(n)
	const resolve = (i: number, depth: number): number => {
		if (done[i] === 1) return resolvedY[i] ?? 0

		let value = buffer.yOffset[i] ?? 0

		if (buffer.attachType[i] === AttachType.CURSIVE && depth < 64) {
			const parent = i + (buffer.attach[i] ?? 0)

			if (parent >= 0 && parent < n && parent !== i) value += resolve(parent, depth + 1)
		}

		done[i] = 1
		resolvedY[i] = value

		return value
	}

	let pen = rtl ? total : 0

	for (let i = 0; i < n; i++) {
		const advance = buffer.xAdvance[i] ?? 0

		if (rtl) pen -= advance

		const baseX = pen
		const kind = buffer.attachType[i]
		const parent = i + (buffer.attach[i] ?? 0)

		if (kind === AttachType.MARK && parent >= 0 && parent < i) {
			x[i] = (x[parent] ?? 0) + (buffer.xOffset[i] ?? 0)
			y[i] = (y[parent] ?? 0) + (buffer.yOffset[i] ?? 0)
		} else {
			x[i] = baseX + (buffer.xOffset[i] ?? 0)
			y[i] = kind === AttachType.CURSIVE ? resolve(i, 0) : (buffer.yOffset[i] ?? 0)
		}

		if (!rtl) pen += advance
	}

	return total
}
