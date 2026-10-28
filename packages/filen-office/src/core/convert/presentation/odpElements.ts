import type { OdpParts } from "../../odp/read/document"
import { PART_CONTENT_TYPES, RELATIONSHIP_TYPES } from "../../pptx/write/parts"
import { IMAGE_RELATIONSHIP, Pieces, attr, xfrmXml, type EmitContext } from "../../pptx/write/emit/shape"
import type { FreshForeignParts } from "../../pptx/write/fresh"
import type { EmitRequest, EmitResult } from "../../pptx/write/types"
import type { Deck, ShapeNode } from "../../presentation/model"
import { heldChart, isHeldChart, XLSX_CONTENT_TYPE } from "../../presentation/edit/apply/chart"
import { CHART_WORKBOOK_ID, odpChartPart, type OdpChartPart } from "./odpChart"
import type { ConversionReport } from "./report"

// What an ODF deck holds in objects of its own, written as PresentationML elements by the conversion: a chart object
// (draw:object of an office:chart, ODF 1.3 Part 3 §11) as a chart part (ECMA-376 Part 1 §21.2) with its data as an
// embedded workbook and the caches it reads (odpChart.ts), framed in p:graphicFrame (§19.3.1.21); a medium
// (draw:plugin, §10.4.7) as a p:pic playing it (§19.3.1.37 with a:videoFile or a:audioFile, §20.1.3.6/§20.1.3.1, and
// PowerPoint 2010's p14:media naming the embedded copy), its poster the picture fill, or a plain grey poster when it has
// none; a linked medium stays linked (never fetched). Charts are read before the write (small objects, bounded).

const CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const P14_MEDIA_EXT = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
const CHART_PREFIX = "filen-chart:"
const WORKBOOK_PREFIX = "filen-chart-workbook:"
const POSTER = "filen-poster.png"
// 16 × 9 mid-grey, 8-bit greyscale.
const POSTER_PNG = Uint8Array.from(
	"89504e470d0a1a0a0000000d49484452000000100000000908000000001e41f3ee0000000f4944415478da636840030c8344000085d44801b508ddd40000000049454e44ae426082".match(
		/../gu
	) ?? [],
	pair => Number.parseInt(pair, 16)
)
const MAX_OBJECT_BYTES = 16 * 1024 * 1024
const MAX_CHARTS = 4096
const MAX_DEPTH = 128

// The deck's chart frames, and the media type of each medium it embeds (the package names media by draw:mime-type).
function objectFrames(shapes: readonly ShapeNode[], charts: ShapeNode[], media: Map<string, string>, depth = 0): void {
	if (depth > MAX_DEPTH) return

	for (const shape of shapes) {
		if (shape.kind === "frame" && shape.frame?.kind === "chart") charts.push(shape)
		if (shape.kind === "frame" && shape.frame?.kind === "media" && shape.frame.media.part !== undefined)
			media.set(shape.frame.media.part.replace(/^\//u, ""), shape.frame.media.contentType)
		if (shape.children !== undefined) objectFrames(shape.children, charts, media, depth + 1)
	}
}

// The object directory a chart frame's part names ("Object 1/chart.xml" → "Object 1").
function objectOf(part: string): string {
	const slash = part.lastIndexOf("/")

	return slash < 0 ? part : part.slice(0, slash)
}

// A chart frame's object content.xml: the version the session holds (an inserted or edited chart), else the package's.
async function objectContent(deck: Deck, parts: OdpParts, part: string, object: string): Promise<Uint8Array | undefined> {
	if (isHeldChart(part)) return heldChart(deck, part)?.object

	const content = `${object}/content.xml`
	const entry = parts.opc.entry(content)

	return entry === undefined || entry.uncompressedSize > MAX_OBJECT_BYTES ? undefined : parts.opc.read(content)
}

export interface OdpObjects {
	readonly parts: FreshForeignParts
	element(request: EmitRequest, context: EmitContext): EmitResult | undefined
	// The PNG an SVG picture is shown by beside it: rasterised by `svgPng`, else the plain poster (reported).
	svgFallback(name: string): Promise<Uint8Array>
}

// The largest SVG picture rasterised for its PNG.
const MAX_SVG_BYTES = 16 * 1024 * 1024

// The deck's chart objects translated, and the foreign parts the fresh writer copies (the package's streams, the
// translated charts, the plain poster).
export async function odpObjects(
	deck: Deck,
	parts: OdpParts,
	report: ConversionReport,
	svgPng?: (svg: Uint8Array) => Promise<Uint8Array | undefined>
): Promise<OdpObjects> {
	const charts = new Map<string, OdpChartPart>()
	const frames: ShapeNode[] = []
	const mediaTypes = new Map<string, string>()

	for (const node of deck.nodes.values()) objectFrames(node.shapes, frames, mediaTypes)

	for (const frame of frames) {
		if (frame.frame?.kind !== "chart" || charts.size >= MAX_CHARTS) continue

		const object = objectOf(frame.frame.part)

		if (charts.has(object)) continue

		const bytes = await objectContent(deck, parts, frame.frame.part, object)
		const part = bytes === undefined ? undefined : await odpChartPart(bytes)

		if (part === undefined) continue

		// What the part could not carry (a trend line, a secondary axis, data without a workbook) is counted once per chart.
		if (part.lost) report.note("chartDetail")

		charts.set(object, part)
	}

	// A chart part's name or its workbook's ("filen-chart:Object 1", "filen-chart-workbook:Object 1").
	const made = (name: string): { readonly object: string; readonly workbook: boolean } | undefined =>
		name.startsWith(CHART_PREFIX)
			? { object: name.slice(CHART_PREFIX.length), workbook: false }
			: name.startsWith(WORKBOOK_PREFIX)
				? { object: name.slice(WORKBOOK_PREFIX.length), workbook: true }
				: undefined
	const madeBytes = (name: string): Uint8Array | undefined => {
		const which = made(name)
		const part = which === undefined ? undefined : charts.get(which.object)

		return which?.workbook === true ? part?.workbook : part?.chart
	}
	const foreign: FreshForeignParts = {
		has: name => name === POSTER || (made(name) === undefined ? parts.opc.has(name) : madeBytes(name) !== undefined),
		contentType: name =>
			name === POSTER
				? "image/png"
				: name.startsWith(CHART_PREFIX)
					? PART_CONTENT_TYPES.chart
					: name.startsWith(WORKBOOK_PREFIX)
						? XLSX_CONTENT_TYPE
						: (parts.contentTypes.typeOf(name) ?? mediaTypes.get(name)),
		read: name => {
			if (name === POSTER) return Promise.resolve(POSTER_PNG)
			if (made(name) !== undefined) {
				const bytes = madeBytes(name)

				return bytes === undefined ? Promise.reject(new Error(`No translated chart ${name}`)) : Promise.resolve(bytes)
			}

			return parts.opc.read(name)
		},
		stream: name => {
			const entry = name === POSTER || made(name) !== undefined ? undefined : parts.opc.entry(name)
			const archive = parts.odf.archive

			return entry === undefined
				? undefined
				: { length: entry.uncompressedSize, crc32: entry.crc32, chunks: () => archive.stream(entry) }
		},
		// A chart part names its embedded workbook (c:externalData r:id).
		relationships: name => {
			const which = made(name)

			return which === undefined || which.workbook || charts.get(which.object)?.workbook === undefined
				? []
				: [{ id: CHART_WORKBOOK_ID, type: RELATIONSHIP_TYPES.embeddedWorkbook, target: `${WORKBOOK_PREFIX}${which.object}` }]
		}
	}

	return {
		parts: foreign,
		svgFallback: async name => {
			const entry = parts.opc.entry(name)
			const png =
				svgPng === undefined || entry === undefined || entry.uncompressedSize > MAX_SVG_BYTES
					? undefined
					: await svgPng(await parts.opc.read(name))

			// Shown by a plain picture where SVG is not drawn (PowerPoint draws the SVG itself).
			if (png === undefined) report.note("picture")

			return png ?? POSTER_PNG
		},
		element: (request, context) => {
			const shape = request.shape

			if (shape === undefined || shape.kind !== "frame") return undefined
			// A chart inserted in the session has no source element, but an object all the same.
			if (shape.frame?.kind === "chart") return chartElement(context, shape, charts, report)
			if (shape.src?.format === "odp" && shape.frame?.kind === "media") return mediaElement(context, shape, foreign, report)

			return undefined
		}
	}
}

function nvPr(shape: ShapeNode, tag: string, locks: string, nv: string): string {
	return (
		`<p:${tag}><p:cNvPr${attr("id", shape.id)}${attr("name", shape.name)}${attr("descr", shape.alt?.descr)}` +
		`${shape.hidden ? ' hidden="1"' : ""}${attr("title", shape.alt?.title)}/>${locks}<p:nvPr>${nv}</p:nvPr></p:${tag}>`
	)
}

function chartElement(
	context: EmitContext,
	shape: ShapeNode,
	charts: ReadonlyMap<string, OdpChartPart>,
	report: ConversionReport
): EmitResult {
	const frame = shape.frame
	const object = frame?.kind === "chart" ? objectOf(frame.part) : undefined

	if (object === undefined || shape.xfrm === undefined || !charts.has(object)) {
		report.note("chart")

		return { kind: "markup", pieces: [] }
	}

	const id = context.parts.relate(`${CHART_PREFIX}${object}`, RELATIONSHIP_TYPES.chart)

	return new Pieces()
		.text(
			`<p:graphicFrame>${nvPr(shape, "nvGraphicFramePr", "<p:cNvGraphicFramePr/>", "")}${xfrmXml("p:xfrm", shape.xfrm, false)}` +
				`<a:graphic><a:graphicData uri="${CHART_URI}"><c:chart xmlns:c="${CHART_URI}" r:id="${id}"/></a:graphicData></a:graphic></p:graphicFrame>`
		)
		.markup()
}

function mediaElement(context: EmitContext, shape: ShapeNode, foreign: FreshForeignParts, report: ConversionReport): EmitResult {
	const media = shape.frame?.kind === "media" ? shape.frame.media : undefined

	if (media === undefined || shape.xfrm === undefined || (media.part === undefined && media.external === undefined)) {
		report.note("media")

		return { kind: "markup", pieces: [] }
	}

	const kind = media.kind
	const part = media.part === undefined ? undefined : media.part.replace(/^\//u, "")

	if (part !== undefined && !foreign.has(part)) {
		report.note("media")

		return { kind: "markup", pieces: [] }
	}

	const poster = media.poster !== undefined && foreign.has(media.poster) ? media.poster : POSTER
	const link =
		part === undefined
			? context.parts.relate(media.external ?? "", `${RELATIONSHIPS}${kind}`, true)
			: context.parts.relate(part, `${RELATIONSHIPS}${kind}`)
	const embed = part === undefined ? undefined : context.parts.relate(part, RELATIONSHIP_TYPES.media)
	const image = context.parts.relate(poster, IMAGE_RELATIONSHIP)
	const extension =
		embed === undefined
			? ""
			: `<p:extLst><p:ext uri="${P14_MEDIA_EXT}"><p14:media xmlns:p14="${P14}" r:embed="${embed}"/></p:ext></p:extLst>`

	if (poster === POSTER) report.note("media")

	return new Pieces()
		.text(
			"<p:pic>" +
				nvPr(
					shape,
					"nvPicPr",
					'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>',
					`<a:${kind}File r:link="${link}"/>${extension}`
				) +
				`<p:blipFill><a:blip r:embed="${image}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
				`<p:spPr>${xfrmXml("a:xfrm", shape.xfrm, false)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
		)
		.markup()
}
