import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
	CLIP_FLOATS,
	CLIP_INTS,
	GRAPHIC_FLOATS,
	GRAPHIC_INTS,
	OBJECT_FLOATS,
	OBJECT_INTS,
	TURN_FLOATS,
	TURN_INTS,
	type DocumentLayout,
	type PageDisplayList
} from "@filen/office/core/docx"
import { FRAGMENT_FLOATS, FRAGMENT_INTS, LINE_FLOATS, LINE_INTS, LineInt } from "@filen/office/core/text"
import { layOut } from "../layoutFixtures"
import { pageDigest } from "../pagedFixtures"

// Page digests: the paged fuzz compares what the editor shows with a fresh layout of the saved file, and the
// viewer digest compares the corpus's unedited layout before and after a change.

function round(value: number | undefined): number {
	return Math.round((value ?? 0) * 10) / 10
}

// A page's lines (geometry to 0.1 pt, flags, region, text) and fragments (x, text range, font, size, info),
// then its objects in paint order (see digestObjects). `media`: a part's bytes, to tell pictures by content (their
// part names differ before and after a save).
export function digestPage(
	layout: Pick<DocumentLayout, "styles" | "objects" | "model" | "decorations">,
	page: PageDisplayList,
	media?: (partName: string) => Uint8Array | undefined
): string {
	const styles = layout.styles
	const text = page.text
	const out = [`#${page.number}|${page.numberText} ${round(page.width)}x${round(page.height)} lines ${text.lineCount}`]

	for (let line = 0; line < text.lineCount; line++) {
		const f = line * LINE_FLOATS
		const i = line * LINE_INTS
		const source = text.lineInts[i + LineInt.SOURCE] ?? -1
		const content = page.sourceTexts[source] ?? ""
		const start = text.lineInts[i + LineInt.TEXT_START] ?? 0
		const end = text.lineInts[i + LineInt.TEXT_END] ?? 0
		const parts: (string | number)[] = [
			round(text.lineFloats[f]),
			round(text.lineFloats[f + 1]),
			round(text.lineFloats[f + 2]),
			round(text.lineFloats[f + 3]),
			round(text.lineFloats[f + 4]),
			text.lineInts[i + LineInt.FLAGS] ?? 0,
			page.sourceRegion(source),
			JSON.stringify(content.slice(start, end))
		]
		const first = text.lineInts[i + LineInt.FIRST_FRAGMENT] ?? 0
		const fragments = text.lineInts[i + LineInt.FRAGMENT_COUNT] ?? 0

		for (let k = first; k < first + fragments; k++) {
			const style = styles.get(text.fragmentInts[k * FRAGMENT_INTS + 2] ?? 0)
			const from = (text.fragmentInts[k * FRAGMENT_INTS] ?? 0) - start
			const to = (text.fragmentInts[k * FRAGMENT_INTS + 1] ?? 0) - start

			parts.push(
				`[${round(text.fragmentFloats[k * FRAGMENT_FLOATS])} ${from}-${to} ${style.font.family}:${style.font.weight}:${String(style.font.italic)}/${style.size} ${text.fragmentInts[k * FRAGMENT_INTS + 3] ?? 0}]`
			)
		}

		out.push(parts.join(" "))
	}

	digestObjects(layout, page, out, media)
	digestGraphics(layout, page, out)

	return out.join("\n")
}

// Each object placed on the page, in paint order: its box, layer and source region, what kind it is, how it
// floats (wrap, behind the text, z-order) and, for a drawing, its rotation, flips and picture crop. Ids are
// left out: two layouts number their objects as they meet them.
function digestObjects(
	layout: Pick<DocumentLayout, "objects" | "model">,
	page: PageDisplayList,
	out: string[],
	media: ((partName: string) => Uint8Array | undefined) | undefined
): void {
	const objects = layout.objects

	for (let k = 0; k < page.objectCount; k++) {
		const f = k * OBJECT_FLOATS
		const i = k * OBJECT_INTS
		const id = page.objectInts[i] ?? -1
		const float = objects.floats[id]
		const kind = objects.kinds[id] ?? 0
		const drawing = kind === 1 ? layout.model.drawings[objects.indices[id] ?? -1] : undefined

		out.push(
			[
				"obj",
				round(page.objectFloats[f]),
				round(page.objectFloats[f + 1]),
				round(page.objectFloats[f + 2]),
				round(page.objectFloats[f + 3]),
				page.objectInts[i + 1] ?? 0,
				page.sourceRegion(page.objectInts[i + 2] ?? -1),
				kind,
				float === undefined ? "inline" : `${float.wrap}/${float.wrapText}/${String(float.behindDoc)}/${float.zOrder}`,
				drawing === undefined ? "" : drawingTransform(layout.model, drawing.part, drawing.graphicData),
				drawing === undefined ? "" : blip(layout.model, drawing.part, drawing.embedId, media)
			].join(" ")
		)
	}
}

// The picture a drawing shows: a hash of its bytes, or (no media given) its part name.
function blip(
	model: DocumentLayout["model"],
	part: number,
	embedId: string | undefined,
	media: ((partName: string) => Uint8Array | undefined) | undefined
): string {
	const name = embedId === undefined ? undefined : model.parts[part]?.relationships.byId(embedId)?.partName

	if (name === undefined) return ""

	const bytes = media?.(name) ?? model.pendingMedia?.media(name)?.bytes

	return `blip ${bytes === undefined ? name : createHash("sha1").update(bytes).digest("hex").slice(0, 12)}`
}

// Fills, borders, rules and bars in paint order (kind, layer, box, what the decoration is: keys are each
// layout's own, 1-based), then the clips rows of exact height cut their cells with (box, lines and objects through it).
function digestGraphics(layout: Pick<DocumentLayout, "decorations">, page: PageDisplayList, out: string[]): void {
	for (let k = 0; k < page.graphicCount; k++) {
		const f = k * GRAPHIC_FLOATS
		const i = k * GRAPHIC_INTS
		const key = page.graphicInts[i + 1] ?? 0

		out.push(
			[
				"gfx",
				page.graphicInts[i] ?? 0,
				page.graphicInts[i + 2] ?? 0,
				round(page.graphicFloats[f]),
				round(page.graphicFloats[f + 1]),
				round(page.graphicFloats[f + 2]),
				round(page.graphicFloats[f + 3]),
				JSON.stringify(key > 0 ? (layout.decorations[key - 1] ?? null) : null)
			].join(" ")
		)
	}

	for (let k = 0; k < page.clipCount; k++) {
		const f = k * CLIP_FLOATS
		const i = k * CLIP_INTS

		out.push(
			[
				"clip",
				round(page.clipFloats[f]),
				round(page.clipFloats[f + 1]),
				round(page.clipFloats[f + 2]),
				round(page.clipFloats[f + 3]),
				(page.clipInts[i + 1] ?? 0) - (page.clipInts[i] ?? 0),
				(page.clipInts[i + 3] ?? 0) - (page.clipInts[i + 2] ?? 0)
			].join(" ")
		)
	}

	for (let k = 0; k < page.turnCount; k++) {
		const f = k * TURN_FLOATS
		const i = k * TURN_INTS

		out.push(
			[
				"turn",
				page.turnInts[i] ?? 0,
				round(page.turnFloats[f]),
				round(page.turnFloats[f + 1]),
				round(page.turnFloats[f + 2]),
				round(page.turnFloats[f + 3]),
				(page.turnInts[i + 2] ?? 0) - (page.turnInts[i + 1] ?? 0),
				(page.turnInts[i + 4] ?? 0) - (page.turnInts[i + 3] ?? 0),
				(page.turnInts[i + 6] ?? 0) - (page.turnInts[i + 5] ?? 0)
			].join(" ")
		)
	}
}

// a:xfrm rot/flipH/flipV and a:srcRect l/t/r/b under a drawing's graphic data, text box content apart.
function drawingTransform(model: DocumentLayout["model"], partIndex: number, node: number): string {
	const document = model.parts[partIndex]?.document

	if (document === undefined || node < 0) return ""

	const found: string[] = []
	const visit = (element: number): void => {
		for (let child = document.firstChildElement(element); child >= 0; child = document.nextSiblingElement(child)) {
			const name = document.localName(child)

			if (name === "xfrm")
				found.push(
					`xfrm ${document.attribute(child, "rot") ?? ""} ${document.attribute(child, "flipH") ?? ""} ${document.attribute(child, "flipV") ?? ""}`
				)
			else if (name === "srcRect")
				found.push(
					`crop ${document.attribute(child, "l") ?? ""} ${document.attribute(child, "t") ?? ""} ${document.attribute(child, "r") ?? ""} ${document.attribute(child, "b") ?? ""}`
				)

			// A text box's content is a story of its own (its objects are placed and digested as such).
			if (name !== "txbxContent") visit(child)
		}
	}

	visit(node)

	return found.join(" ")
}

function lineDifference(a: string, b: string): string {
	const x = a.split("\n")
	const y = b.split("\n")

	for (let i = 0; i < Math.max(x.length, y.length); i++)
		if (x[i] !== y[i]) return `  line ${i}\n  shown: ${(x[i] ?? "").slice(0, 400)}\n  fresh: ${(y[i] ?? "").slice(0, 400)}`

	return "?"
}

// The first difference between two page lists, or undefined when they are equal.
export function firstDifference(shown: readonly string[], fresh: readonly string[]): string | undefined {
	for (let i = 0; i < Math.min(shown.length, fresh.length); i++) {
		if (shown[i] === fresh[i]) continue

		const where =
			shown.length === fresh.length ? `page ${i}` : `page count ${shown.length} vs ${fresh.length}; first difference page ${i}`

		return `${where}:\n${lineDifference(shown[i] ?? "", fresh[i] ?? "")}`
	}

	return shown.length === fresh.length ? undefined : `page count ${shown.length} vs ${fresh.length}`
}

// ---- viewer digest ----

// A file's page count and a hash of its pages (pagedFixtures' digest), or why it does not lay out.
export async function viewerDigest(file: string): Promise<string> {
	try {
		const pages = pageDigest(await layOut(new Uint8Array(readFileSync(file))))

		return `${pages.length}:${createHash("sha1").update(pages.join("\n")).digest("hex")}`
	} catch (error) {
		return `ERR ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`
	}
}
