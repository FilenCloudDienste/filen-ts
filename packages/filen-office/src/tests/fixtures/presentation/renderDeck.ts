import { D, drawingReader } from "../../../core/drawingml/reader"
import {
	slideRef,
	type Deck,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type SourceRef,
	type TextBody,
	type Xfrm
} from "../../../core/presentation/model"
import type { RenderServices, TextLayoutRequest, TextLayoutResult } from "../../../core/presentation/render/services"
import { bytesSource, partKey, type Relationships } from "../../../core/opc/index"
import { openPptx } from "../../../core/pptx/package"
import { parseXml, type XmlDocument } from "../../../core/xml/index"
import { fixtureTextPage } from "./textPage"

// In-memory pptx parts for renderer tests: the parts as markup, their relationships, and model nodes pointing into
// them (src), the way the pptx reader builds them; plus a text service recording what it was asked to lay out.

export const NS =
	'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
	'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
	'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"'

export const THEME_PART = "/ppt/theme/theme1.xml"

export const THEME = `<a:theme ${NS} name="T"><a:themeElements>
	<a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
		<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
		<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
		<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
	<a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
		<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
	<a:fmtScheme name="m">
		<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:noFill/></a:fillStyleLst>
		<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
		<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:glow rad="63500"><a:schemeClr val="phClr"/></a:glow></a:effectLst></a:effectStyle></a:effectStyleLst>
		<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:bgFillStyleLst>
	</a:fmtScheme></a:themeElements></a:theme>`

export interface FixtureParts {
	readonly parts: Readonly<Record<string, string>>
	// part → rId → target (absolute) or { target, external }.
	readonly rels?: Readonly<Record<string, Readonly<Record<string, string | { readonly target: string; readonly external: true }>>>>
	readonly types?: Readonly<Record<string, string>>
}

export interface RenderFixture {
	readonly services: RenderServices
	readonly documents: Map<string, XmlDocument>
	readonly requests: TextLayoutRequest[]
}

export function renderServices(
	input: FixtureParts,
	options: { readonly text?: boolean; readonly textHeight?: number } = {}
): RenderFixture {
	const documents = new Map<string, XmlDocument>()
	const requests: TextLayoutRequest[] = []

	for (const [part, markup] of Object.entries(input.parts)) documents.set(part, parseXml(new TextEncoder().encode(markup)))

	const services: RenderServices = {
		xml: part => documents.get(part),
		relationship: (part, id) => {
			const target = input.rels?.[part]?.[id]

			if (target === undefined) return undefined

			return typeof target === "string" ? { target, external: false } : { target: target.target, external: true }
		},
		contentType: part =>
			input.types?.[part] ??
			(part.endsWith(".png")
				? "image/png"
				: part.endsWith(".svg")
					? "image/svg+xml"
					: part.endsWith(".jpeg")
						? "image/jpeg"
						: undefined),
		...(options.text === false
			? {}
			: {
					layoutText: (request: TextLayoutRequest): TextLayoutResult => {
						requests.push(request)

						const paragraphs = request.body.paragraphs.map(paragraph =>
							paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join("")
						)

						return {
							page: fixtureTextPage(paragraphs, { width: request.width }),
							height: options.textHeight ?? paragraphs.length * 24
						}
					}
				})
	}

	return { services, documents, requests }
}

// The element with cNvPr id `id` (a p:sp, p:pic, p:grpSp, p:graphicFrame or mc:AlternateContent holding one).
export function elementById(document: XmlDocument, id: number): number {
	const reader = drawingReader(document)

	for (let node = 1; node < document.count; node++) {
		if (!reader.is(node, D.A, "cNvPr") && !reader.is(node, D.P, "cNvPr")) continue
		if (reader.attr(node, "id") !== String(id)) continue

		// cNvPr → nvSpPr → the shape.
		const shape = document.parent(document.parent(node))
		const branch = document.parent(shape)
		const holder = branch < 0 ? -1 : document.parent(branch)

		return holder >= 0 && reader.is(holder, D.MC, "AlternateContent") ? holder : shape
	}

	throw new Error(`No shape ${String(id)}`)
}

export function src(fixture: RenderFixture, part: string, node: number): SourceRef {
	if (!fixture.documents.has(part)) throw new Error(`No part ${part}`)

	return { format: "pptx", part, node, epoch: 0 }
}

export function body(...paragraphs: string[]): TextBody {
	return { bodyPr: {}, paragraphs: paragraphs.map(text => ({ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] })) }
}

export function xfrm(x: number, y: number, cx: number, cy: number, extra: Partial<Xfrm> = {}): Xfrm {
	return { x, y, cx, cy, rot: 0, flipH: false, flipV: false, ...extra }
}

export function slideNode(
	ref: SlideRef,
	kind: SlideNode["kind"],
	part: string,
	shapes: ShapeNode[],
	extra: Partial<SlideNode> = {}
): SlideNode {
	return { ref, kind, part, showMasterShapes: true, hidden: false, shapes, comments: [], revision: 0, ...extra }
}

export const MASTER = slideRef(1)
export const LAYOUT = slideRef(2)
export const SLIDE = slideRef(3)

export const MASTER_PART = "/ppt/slideMasters/slideMaster1.xml"
export const LAYOUT_PART = "/ppt/slideLayouts/slideLayout1.xml"
export const SLIDE_PART = "/ppt/slides/slide1.xml"

// A deck of one master, one layout and one slide, from their shape lists.
export function deckOf(
	master: ShapeNode[],
	layout: ShapeNode[],
	slide: ShapeNode[],
	extra: { master?: Partial<SlideNode>; layout?: Partial<SlideNode>; slide?: Partial<SlideNode> } = {}
): Deck {
	const nodes = new Map<SlideRef, SlideNode>([
		[
			MASTER,
			slideNode(MASTER, "master", MASTER_PART, master, {
				theme: { part: THEME_PART, revision: 0 },
				clrMap: {
					bg1: "lt1",
					tx1: "dk1",
					bg2: "lt2",
					tx2: "dk2",
					accent1: "accent1",
					accent2: "accent2",
					accent3: "accent3",
					accent4: "accent4",
					accent5: "accent5",
					accent6: "accent6",
					hlink: "hlink",
					folHlink: "folHlink"
				},
				...extra.master
			})
		],
		[LAYOUT, slideNode(LAYOUT, "layout", LAYOUT_PART, layout, { parent: MASTER, ...extra.layout })],
		[SLIDE, slideNode(SLIDE, "slide", SLIDE_PART, slide, { parent: LAYOUT, ...extra.slide })]
	])

	return {
		format: "pptx",
		variant: "pptx",
		size: { cx: 12_192_000, cy: 6_858_000 },
		notesSize: { cx: 6_858_000, cy: 9_144_000 },
		firstSlideNumber: 1,
		slides: [SLIDE],
		masters: [MASTER],
		layouts: [LAYOUT],
		nodes,
		sections: [],
		customShows: [],
		show: { kind: "present", loop: false, showNarration: true, showAnimation: true, useTimings: true, range: { kind: "all" } },
		defaultTextStyle: { levels: [] },
		embeddedFonts: [],
		protection: {},
		gate: [],
		authors: [],
		opaque: [],
		revision: 0
	}
}

export function part(spTree: string, root: "sld" | "sldLayout" | "sldMaster" = "sld"): string {
	return `<p:${root} ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${spTree}</p:spTree></p:cSld></p:${root}>`
}

// A corpus deck opened by the pptx reader with every slide parsed, and render services over its package: every XML
// part and every part's relationships loaded up front (the worker loads what a slide needs before rendering it).
export async function openRenderDeck(bytes: Uint8Array): Promise<{ readonly deck: Deck; readonly services: RenderServices } | undefined> {
	const opened = await openPptx(bytesSource(bytes))

	if (opened.kind !== "opened") return undefined

	const { deck, parts } = opened

	for (const ref of deck.slides) await parts.slide(ref)

	const opc = parts.opc
	const documents = new Map<string, XmlDocument>()
	const relationships = new Map<string, Relationships>()
	const contentTypes = await opc.contentTypes()

	for (const entry of opc.entries()) {
		const name = `/${entry.name}`
		const key = partKey(name)

		if (/\.xml$/i.test(entry.name) && entry.uncompressedSize < 64 * 1024 * 1024) {
			const held = parts.document(name)

			try {
				documents.set(key, held ?? (await opc.xml(name)))
			} catch {
				continue
			}

			relationships.set(key, await opc.relationships(entry.name))
		}
	}

	const services: RenderServices = {
		xml: part => documents.get(partKey(part)),
		relationship: (part, id) => {
			const relationship = relationships.get(partKey(part))?.byId(id)

			if (relationship === undefined) return undefined

			return relationship.external || relationship.partName === undefined
				? { target: relationship.target, external: true, type: relationship.type }
				: { target: `/${relationship.partName}`, external: false, type: relationship.type }
		},
		contentType: part => contentTypes.typeOf(part.startsWith("/") ? part.slice(1) : part),
		async bytes(part, limit) {
			const key = partKey(part)
			const entry = opc.entry(key)

			return entry === undefined || entry.uncompressedSize > limit ? undefined : await opc.read(key)
		}
	}

	return { deck, services }
}
