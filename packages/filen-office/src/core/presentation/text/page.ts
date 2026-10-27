import { CLIP_FLOATS, CLIP_INTS, LINK_INTS, Region, SOURCE_INTS, type DocxPageData } from "../../docx/layout/index"
import type { DocxPdfPage, DocxPdfRole } from "../../docx/pdf/types"
import type { TextLayout } from "../../text/index"
import type { TextPage } from "../output"
import type { BodySession } from "./body"

// A laid-out body as the docx painters' page data: one page the size of the body's box (turned for vertical
// text), every count and array present, graphics empty, objects the picture bullets, one source per paragraph (region TEXTBOX,
// item = paragraph index), links over the runs that carry one. Arrays are tight copies, so a page can be
// transferred while the layout stays usable.

// An object of a text page that is a picture bullet (objectInts: index into TextPage.images, layer, paragraph); above
// the docx object kinds.
export const PICTURE_BULLET_OBJECT = 64

// The objects a body's page carries (picture bullets), OBJECT_FLOATS and OBJECT_INTS per object.
export interface PageObjects {
	readonly floats: Float32Array
	readonly ints: Int32Array
	readonly kinds: Uint8Array
	readonly images: readonly string[]
}

export function assemblePage(
	out: TextLayout,
	texts: readonly string[],
	session: BodySession,
	width: number,
	height: number,
	objects?: PageObjects
): TextPage {
	const tight = out.compact()

	return pageOf(
		{
			lineCount: tight.lineCount,
			fragmentCount: tight.fragmentCount,
			decorationCount: tight.decorationCount,
			lineFloats: tight.lineFloats,
			lineInts: tight.lineInts,
			fragmentFloats: tight.fragmentFloats,
			fragmentInts: tight.fragmentInts,
			decorationFloats: tight.decorationFloats,
			decorationInts: tight.decorationInts
		},
		texts,
		session,
		width,
		height,
		objects
	)
}

export interface PageLines {
	readonly lineCount: number
	readonly fragmentCount: number
	readonly decorationCount: number
	readonly lineFloats: Float32Array
	readonly lineInts: Int32Array
	readonly fragmentFloats: Float32Array
	readonly fragmentInts: Int32Array
	readonly decorationFloats: Float32Array
	readonly decorationInts: Int32Array
}

export function pageOf(
	lines: PageLines,
	texts: readonly string[],
	session: BodySession,
	width: number,
	height: number,
	objects?: PageObjects
): TextPage {
	const sourceInts = new Int32Array(SOURCE_INTS * texts.length)

	for (let source = 0; source < texts.length; source++) sourceInts.set([Region.TEXTBOX, 0, source, 0], source * SOURCE_INTS)

	const page: DocxPageData = {
		index: 0,
		number: 1,
		numberText: "1",
		section: 0,
		width: Math.max(0, width),
		height: Math.max(0, height),
		...lines,
		graphicCount: 0,
		graphicFloats: new Float32Array(0),
		graphicInts: new Int32Array(0),
		objectCount: objects?.kinds.length ?? 0,
		objectFloats: objects?.floats ?? new Float32Array(0),
		objectInts: objects?.ints ?? new Int32Array(0),
		objectKinds: objects?.kinds ?? new Uint8Array(0),
		sourceCount: texts.length,
		sourceInts,
		sourceTexts: texts,
		linkCount: session.linkInts.length / LINK_INTS,
		linkInts: Int32Array.from(session.linkInts)
	}

	return {
		page,
		styles: session.docxStyles,
		paints: session.paints,
		strokes: session.strokes,
		textEffects: session.effects,
		decorations: session.decorations.values,
		links: session.links,
		...(objects === undefined ? {} : { images: objects.images })
	}
}

const PARAGRAPH: DocxPdfRole = { kind: "paragraph", level: 0, list: -1, cells: [] }

// The page as DocxPagePainter reads it: no clips, every paragraph tagged P, keys by paragraph index. The painter
// draws it under the shape's matrix (the host wraps the call in q … cm … Q). The arrays are the page's own (no
// copy): a PDF job reads them where they arrived.
export function toDocxPdfPage(text: TextPage): DocxPdfPage {
	const page = text.page
	const roles: DocxPdfRole[] = []
	const keys: string[] = []

	for (let source = 0; source < page.sourceCount; source++) {
		roles.push(PARAGRAPH)
		keys.push(`p${source}`)
	}

	return {
		index: page.index,
		width: page.width,
		height: page.height,
		lineCount: page.lineCount,
		fragmentCount: page.fragmentCount,
		decorationCount: page.decorationCount,
		lineFloats: page.lineFloats,
		lineInts: page.lineInts,
		fragmentFloats: page.fragmentFloats,
		fragmentInts: page.fragmentInts,
		decorationFloats: page.decorationFloats,
		decorationInts: page.decorationInts,
		graphicCount: page.graphicCount,
		graphicFloats: page.graphicFloats,
		graphicInts: page.graphicInts,
		objectCount: page.objectCount,
		objectFloats: page.objectFloats,
		objectInts: page.objectInts,
		sourceCount: page.sourceCount,
		sourceInts: page.sourceInts,
		sourceTexts: page.sourceTexts,
		...(page.sourceOwners === undefined ? {} : { sourceOwners: page.sourceOwners }),
		linkCount: page.linkCount,
		linkInts: page.linkInts,
		clipCount: 0,
		clipFloats: new Float32Array(CLIP_FLOATS * 0),
		clipInts: new Int32Array(CLIP_INTS * 0),
		roles,
		keys
	}
}
