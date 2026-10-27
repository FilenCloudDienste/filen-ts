import { LINK_INTS } from "../../../core/docx/layout/pageData"
import { FRAGMENT_FLOATS, FRAGMENT_INTS, LINE_FLOATS, LINE_INTS } from "../../../core/text/displayList"
import type { SlideLayer } from "../../../core/presentation/output"

// Where a click on the stage's bitmaps lands on a link: the boxes (text px of the layer's TextPage) of each linked
// text range, line by line, from the laid-out fragments (a fragment cut by a link boundary counts its share of
// characters). The stage places them under the layer's text matrix, as transparent buttons that move with the layer.

export interface LinkBox {
	// Index into the layer's TextPage.links.
	readonly link: number
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

export function linkBoxes(layer: SlideLayer): LinkBox[] {
	const text = layer.text

	if (text === undefined || text.page.linkCount === 0) return []

	const page = text.page
	const out: LinkBox[] = []

	for (let k = 0; k < page.linkCount; k++) {
		const source = page.linkInts[k * LINK_INTS] ?? -1
		const start = page.linkInts[k * LINK_INTS + 1] ?? 0
		const end = page.linkInts[k * LINK_INTS + 2] ?? 0
		const link = page.linkInts[k * LINK_INTS + 3] ?? -1

		if (link < 0 || end <= start) continue

		for (let line = 0; line < page.lineCount; line++) {
			const li = line * LINE_INTS

			if ((page.lineInts[li + 5] ?? -1) !== source) continue

			const first = page.lineInts[li] ?? 0
			const count = page.lineInts[li + 1] ?? 0
			let x0 = Number.POSITIVE_INFINITY
			let x1 = Number.NEGATIVE_INFINITY

			for (let fragment = first; fragment < first + count; fragment++) {
				const fs = page.fragmentInts[fragment * FRAGMENT_INTS] ?? 0
				const fe = page.fragmentInts[fragment * FRAGMENT_INTS + 1] ?? 0
				const from = Math.max(fs, start)
				const to = Math.min(fe, end)

				if (to <= from || fe <= fs) continue

				const fx = page.fragmentFloats[fragment * FRAGMENT_FLOATS] ?? 0
				const fw = page.fragmentFloats[fragment * FRAGMENT_FLOATS + 1] ?? 0

				x0 = Math.min(x0, fx + (fw * (from - fs)) / (fe - fs))
				x1 = Math.max(x1, fx + (fw * (to - fs)) / (fe - fs))
			}

			if (x1 > x0)
				out.push({
					link,
					x: x0,
					y: page.lineFloats[line * LINE_FLOATS] ?? 0,
					width: x1 - x0,
					height: page.lineFloats[line * LINE_FLOATS + 1] ?? 0
				})
		}
	}

	return out
}

// A layer's matrix as CSS (an element at the slide origin with transform-origin 0 0).
export function matrixCss(matrix: readonly number[]): string {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix

	return `matrix(${String(a)},${String(b)},${String(c)},${String(d)},${String(e)},${String(f)})`
}
