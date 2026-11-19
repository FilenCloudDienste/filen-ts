import { LINE_FLOATS } from "../../../core/text/index"
import { RECT_FLOATS, type DocxAnnotations } from "../../../dom/docx/annotations"
import type { DocxPageData } from "../../../dom/docx/protocol"

// Where comments and tracked changes go beside and on the pages, as numbers an app draws with its own UI:
// comment threads and formatting changes anchored per page, the lines change bars mark, and the boxes of
// commented text. All values are page px (unscaled); an app multiplies by its zoom.

export interface DocxAnnotationAnchor {
	// Index into comments (threads) or revisions (formatting changes).
	readonly index: number
	// The anchor: where the annotated text starts.
	readonly x: number
	readonly y: number
	readonly height: number
}

export interface DocxThread {
	readonly comment: number
	// Replies in document order, nested replies flattened.
	readonly replies: readonly number[]
}

export interface DocxPageAnnotations {
	// Root comments whose text starts on this page, top to bottom.
	readonly threads: readonly DocxAnnotationAnchor[]
	// Formatting changes starting on this page, top to bottom.
	readonly formatting: readonly DocxAnnotationAnchor[]
	// Changed lines: top and height pairs, merged where they touch.
	readonly bars: Float32Array
	// Commented text on this page: pairs of the thread's root comment and a box (index into the rects).
	readonly ranges: Int32Array
}

export interface DocxAnnotationIndex {
	readonly pages: ReadonlyMap<number, DocxPageAnnotations>
	// Per comment index: its thread (roots) or undefined (replies).
	readonly threads: readonly (DocxThread | undefined)[]
	// Comments nothing in the laid-out text anchors: shown at the top of the first page.
	readonly unanchored: readonly number[]
}

interface PageBuild {
	readonly threads: DocxAnnotationAnchor[]
	readonly formatting: DocxAnnotationAnchor[]
	readonly bars: number[]
	readonly ranges: number[]
}

function rectAt(annotations: DocxAnnotations, rect: number): DocxAnnotationAnchor & { readonly page: number } {
	const f = rect * RECT_FLOATS

	return {
		index: -1,
		page: annotations.rectPages[rect] ?? -1,
		x: annotations.rectFloats[f] ?? 0,
		y: annotations.rectFloats[f + 1] ?? 0,
		height: annotations.rectFloats[f + 3] ?? 0
	}
}

function byPosition(a: DocxAnnotationAnchor, b: DocxAnnotationAnchor): number {
	return a.y - b.y || a.x - b.x || a.index - b.index
}

// Each comment's thread root, one walk per chain. A chain that breaks (no parent, or one out of range) ends at
// its last comment; one that loops roots at the loop's first comment in document order, so exactly one member
// of a loop is a thread and the others, with any chain hanging off it, its replies. The editor's comment list
// (core/docx/review/comments.ts) resolves a loop differently: every member there is a root.
function threadRoots(comments: DocxAnnotations["comments"]): Int32Array {
	const roots = new Int32Array(comments.length).fill(-1)
	// The walk (its start) that last visited each comment.
	const visited = new Int32Array(comments.length).fill(-1)
	const path: number[] = []

	for (let start = 0; start < comments.length; start++) {
		if ((roots[start] ?? -1) >= 0) continue

		path.length = 0

		let at = start
		let root = -1

		while (root < 0) {
			const known = roots[at] ?? -1

			if (known >= 0) {
				root = known
			} else if (visited[at] === start) {
				root = at

				for (let k = path.indexOf(at); k < path.length; k++) root = Math.min(root, path[k] ?? root)
			} else {
				visited[at] = start
				path.push(at)

				const parent = comments[at]?.parent ?? -1

				if (parent < 0 || parent >= comments.length || parent === at) root = at
				else at = parent
			}
		}

		for (const comment of path) roots[comment] = root
	}

	return roots
}

// Merges [top, top + height) spans (sorted by top) where they overlap or touch.
function mergeSpans(spans: number[]): Float32Array {
	const pairs: [number, number][] = []

	for (let k = 0; k + 1 < spans.length; k += 2) pairs.push([spans[k] ?? 0, spans[k + 1] ?? 0])

	pairs.sort((a, b) => a[0] - b[0])

	const out: number[] = []

	for (const [top, height] of pairs) {
		const last = out.length - 2

		if (last >= 0 && top <= (out[last] ?? 0) + (out[last + 1] ?? 0) + 0.5) {
			out[last + 1] = Math.max(out[last + 1] ?? 0, top + height - (out[last] ?? 0))
		} else {
			out.push(top, height)
		}
	}

	return Float32Array.from(out)
}

export function indexAnnotations(annotations: DocxAnnotations): DocxAnnotationIndex {
	const builds = new Map<number, PageBuild>()
	const build = (page: number): PageBuild => {
		let entry = builds.get(page)

		if (entry === undefined) {
			entry = { threads: [], formatting: [], bars: [], ranges: [] }
			builds.set(page, entry)
		}

		return entry
	}
	const threads: (DocxThread | undefined)[] = annotations.comments.map(() => undefined)
	const replies = new Map<number, number[]>()
	const unanchored: number[] = []
	const roots = threadRoots(annotations.comments)

	annotations.comments.forEach((comment, index) => {
		const root = roots[index] ?? index

		for (let rect = comment.firstRect; rect < comment.firstRect + comment.rectCount; rect++) {
			build(annotations.rectPages[rect] ?? -1).ranges.push(root, rect)
		}

		if (root !== index) {
			const list = replies.get(root)

			if (list === undefined) replies.set(root, [index])
			else list.push(index)

			return
		}

		if (comment.rectCount === 0) {
			unanchored.push(index)

			return
		}

		const { page, ...anchor } = rectAt(annotations, comment.firstRect)

		build(page).threads.push({ ...anchor, index })
	})

	annotations.comments.forEach((_, index) => {
		if (roots[index] === index) threads[index] = { comment: index, replies: replies.get(index) ?? [] }
	})

	annotations.revisions.forEach((revision, index) => {
		if (revision.rectCount === 0) return

		if (revision.kind === "formatting" && revision.target !== "section") {
			const { page, ...anchor } = rectAt(annotations, revision.firstRect)

			build(page).formatting.push({ ...anchor, index })
		}

		for (let rect = revision.firstRect; rect < revision.firstRect + revision.rectCount; rect++) {
			const { page, y, height } = rectAt(annotations, rect)

			build(page).bars.push(y, Math.max(1, height))
		}
	})

	const pages = new Map<number, DocxPageAnnotations>()

	for (const [page, entry] of builds) {
		pages.set(page, {
			threads: entry.threads.sort(byPosition),
			formatting: entry.formatting.sort(byPosition),
			bars: mergeSpans(entry.bars),
			ranges: Int32Array.from(entry.ranges)
		})
	}

	return { pages, threads, unanchored }
}

// Where change bars stand on a page: a little left of its leftmost line (the body's margin edge).
export function changeBarX(page: DocxPageData, offset = 12): number {
	let left = Number.POSITIVE_INFINITY

	for (let line = 0; line < page.lineCount; line++) left = Math.min(left, page.lineFloats[line * LINE_FLOATS + 3] ?? 0)

	return Number.isFinite(left) ? Math.max(2, left - offset) : 2
}

export interface BalloonPlacement {
	// Space between balloons.
	readonly gap: number
	// The column's top (no balloon above it).
	readonly top?: number
	// The column's bottom: balloons that do not fit above it are left out, with room kept for a control
	// of `more` px that shows them.
	readonly bottom?: number
	readonly more?: number
	// The balloon that keeps its anchor's height, the others making way above and below.
	readonly active?: number
}

export interface BalloonLayout {
	readonly tops: Float64Array
	// How many balloons (from the first) are shown; the rest go behind the "more" control.
	readonly shown: number
	// Where that control goes, when there is one.
	readonly moreTop: number
}

function stack(tops: Float64Array, heights: readonly number[], count: number, gap: number, floor: number, ceiling: number): void {
	// Up from the column's bottom while there is room, then down from its top: what fits keeps clear of both.
	for (let k = Number.isFinite(ceiling) ? count - 1 : -1; k >= 0; k--) {
		const limit = k === count - 1 ? ceiling : (tops[k + 1] ?? 0) - gap

		tops[k] = Math.min(tops[k] ?? 0, limit - (heights[k] ?? 0))
	}

	for (let k = 0; k < count; k++) {
		const below = k === 0 ? floor : (tops[k - 1] ?? 0) + (heights[k - 1] ?? 0) + gap

		tops[k] = Math.max(tops[k] ?? 0, below)
	}
}

// Tops for balloons wanted at `wanted` (ascending) with `heights`, none overlapping and all inside the
// column: each takes its anchor's height or the first free place below the one before; an active balloon
// stays at its anchor and those above it move up while there is room. Balloons that do not fit at all are
// counted out, last first (the active one stays).
export function placeBalloons(wanted: readonly number[], heights: readonly number[], placement: BalloonPlacement): BalloonLayout {
	const count = wanted.length
	const tops = Float64Array.from(wanted)
	const gap = placement.gap
	const floor = placement.top ?? Number.NEGATIVE_INFINITY
	const ceiling = placement.bottom ?? Number.POSITIVE_INFINITY
	const active = placement.active ?? -1

	if (active >= 0 && active < count) {
		for (let k = active - 1; k >= 0; k--) {
			tops[k] = Math.min(tops[k] ?? 0, (tops[k + 1] ?? 0) - gap - (heights[k] ?? 0))
		}
	}

	stack(tops, heights, count, gap, floor, Number.POSITIVE_INFINITY)

	const last = count - 1

	if (count === 0 || (tops[last] ?? 0) + (heights[last] ?? 0) <= ceiling) return { tops, shown: count, moreTop: ceiling }

	stack(tops, heights, count, gap, floor, ceiling)

	if ((tops[last] ?? 0) + (heights[last] ?? 0) <= ceiling) return { tops, shown: count, moreTop: ceiling }

	// Too many for the column: as many as fit above the control, the rest behind it.
	const more = placement.more ?? 0
	let used = 0
	let shown = 0

	while (shown < count && used + (heights[shown] ?? 0) + gap + more <= ceiling - floor) {
		used += (heights[shown] ?? 0) + gap
		shown++
	}

	if (active >= shown && active < count) shown = Math.min(shown, active + 1)

	const kept = Float64Array.from(wanted.slice(0, shown))

	stack(kept, heights, shown, gap, floor, ceiling - more - gap)

	const moreTop = shown === 0 ? floor : (kept[shown - 1] ?? 0) + (heights[shown - 1] ?? 0) + gap

	return { tops: kept, shown, moreTop }
}
