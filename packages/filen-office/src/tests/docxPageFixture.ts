import { FragmentKind, LineFlag } from "../core/text/index"
import type { DocxPageData, DocxTextStyle } from "../dom/docx/protocol"
import type { DocxTables } from "../react/docx/store"

// Hand-made page display lists for the DOM page painter: lines of fragments over source texts, graphics and placed
// objects, in the arrays the layout hands the renderer.

export const FIXTURE_STYLE: DocxTextStyle = {
	font: "400 16px serif",
	smallCapsFont: "400 11.2px serif",
	color: "000000",
	kerning: true,
	letterSpacing: 0,
	scaleX: 1,
	shift: 0,
	ascent: 12,
	descent: 4,
	revision: 0
}

export const FIXTURE_TABLES: DocxTables = { styles: [FIXTURE_STYLE], decorations: [{ kind: "color", color: "EEEEEE" }], links: [] }

export interface FixtureFragment {
	readonly start: number
	readonly end: number
	readonly x?: number
	readonly width?: number
	// FragmentKind | FragmentFlag bits.
	readonly info?: number
	readonly aux?: number
}

export interface FixtureLine {
	readonly top: number
	readonly source: number
	// The line's text range in its source (TEXT_START, TEXT_END).
	readonly start: number
	readonly end: number
	readonly flags?: number
	readonly fragments: readonly FixtureFragment[]
}

export interface FixtureObject {
	readonly id: number
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	readonly layer?: number
	readonly kind?: number
}

export interface FixtureGraphic {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	// PageGraphic kind, decoration key, layer.
	readonly kind: number
	readonly key: number
	readonly layer: number
}

export interface FixturePage {
	readonly sources: readonly string[]
	readonly lines: readonly FixtureLine[]
	readonly objects?: readonly FixtureObject[]
	readonly graphics?: readonly FixtureGraphic[]
	// Unused numbers after the graphics (capacity a layout array may carry).
	readonly graphicSlack?: number
	readonly turns?: { readonly floats: Float32Array; readonly ints: Int32Array; readonly objectTurns?: Int32Array }
}

// A text fragment of style 0.
export function text(start: number, end: number, x = 96, info: number = FragmentKind.TEXT): FixtureFragment {
	return { start, end, x, width: (end - start) * 8, info }
}

// An inline object fragment (one character of its source).
export function objectFragment(start: number, id: number, x = 96): FixtureFragment {
	return { start, end: start + 1, x, width: 20, info: FragmentKind.OBJECT, aux: id }
}

// A paragraph of one line showing all of `source`.
export function paragraph(top: number, source: number, length: number, fragments?: readonly FixtureFragment[]): FixtureLine {
	return { top, source, start: 0, end: length, flags: LineFlag.FIRST | LineFlag.LAST, fragments: fragments ?? [text(0, length)] }
}

export function fixturePage(spec: FixturePage): DocxPageData {
	const lineFloats: number[] = []
	const lineInts: number[] = []
	const fragmentFloats: number[] = []
	const fragmentInts: number[] = []
	let fragments = 0

	for (const line of spec.lines) {
		lineFloats.push(line.top, 20, line.top + 16, 96, 600)
		lineInts.push(fragments, line.fragments.length, line.start, line.end, line.flags ?? 0, line.source, 0)

		for (const fragment of line.fragments) {
			fragmentFloats.push(fragment.x ?? 96, fragment.width ?? 0, 0, 0)
			fragmentInts.push(fragment.start, fragment.end, 0, fragment.info ?? FragmentKind.TEXT, fragment.aux ?? 0)
			fragments++
		}
	}

	const objects = spec.objects ?? []
	const graphics = spec.graphics ?? []
	const slack = spec.graphicSlack ?? 0
	const graphicFloats = new Float32Array(graphics.length * 4 + slack * 4)
	const graphicInts = new Int32Array(graphics.length * 3 + slack * 3)

	graphics.forEach((graphic, g) => {
		graphicFloats.set([graphic.x, graphic.y, graphic.width, graphic.height], g * 4)
		graphicInts.set([graphic.kind, graphic.key, graphic.layer], g * 3)
	})

	// Slack holds numbers no reader may look at.
	graphicFloats.fill(7, graphics.length * 4)
	graphicInts.fill(7, graphics.length * 3)

	return {
		index: 0,
		number: 1,
		numberText: "1",
		section: 0,
		width: 816,
		height: 1056,
		lineCount: spec.lines.length,
		fragmentCount: fragments,
		decorationCount: 0,
		lineFloats: Float32Array.from(lineFloats),
		lineInts: Int32Array.from(lineInts),
		fragmentFloats: Float32Array.from(fragmentFloats),
		fragmentInts: Int32Array.from(fragmentInts),
		decorationFloats: new Float32Array(0),
		decorationInts: new Int32Array(0),
		graphicCount: graphics.length,
		graphicFloats,
		graphicInts,
		objectCount: objects.length,
		objectFloats: Float32Array.from(objects.flatMap(object => [object.x, object.y, object.width, object.height])),
		objectInts: Int32Array.from(objects.flatMap(object => [object.id, object.layer ?? 1, -1])),
		objectKinds: Uint8Array.from(objects.map(object => object.kind ?? 0)),
		sourceCount: spec.sources.length,
		sourceInts: new Int32Array(spec.sources.length * 4),
		sourceTexts: spec.sources,
		linkCount: 0,
		linkInts: new Int32Array(0),
		...(spec.turns === undefined
			? {}
			: {
					turnCount: spec.turns.ints.length / 7,
					turnFloats: spec.turns.floats,
					turnInts: spec.turns.ints,
					...(spec.turns.objectTurns === undefined ? {} : { objectTurns: spec.turns.objectTurns })
				})
	}
}
