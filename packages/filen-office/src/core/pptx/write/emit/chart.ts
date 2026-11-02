import {
	INSERTED_WORKBOOK_ID,
	chartHeldBy,
	chartOwner,
	ownsHome,
	heldChart,
	isHeldChart,
	noteChartWrite,
	versionWorkbook,
	workbookHeld,
	type HeldChart
} from "../../../presentation/edit/apply/chart"
import { refused, type FrameRef, type Refused, type ShapeNode, type SlideRef } from "../../../presentation/model"
import { CHART_TYPE } from "../../../xlsx/charts/parts"
import type { XmlDocument } from "../../../xml/index"
import { G } from "../../read/xml"
import { RELATIONSHIP_TYPES } from "../parts"
import type { EmitPiece, EmitResult, PartsApi, PptxEmitFamily } from "../types"
import { attr, readerOf, shapeElement, sourceNode, xfrmXml, type EmitContext } from "./shape"

// A chart's p:graphicFrame (ECMA-376 Part 1 §19.3.1.21; a:graphicData c:chart §21.2.2.27) and its parts. A frame that
// names the package's chart is the shape family's (its a:graphic kept as written). A frame naming a version the
// session holds (apply/chart.ts) writes it: into its home, the chart part it came from or an earlier save wrote, when
// the home does not hold it yet (the part replaced whole, its relationships kept), with its embedded workbook
// likewise; else, for an inserted chart, as a new chart part whose embedded workbook is related from it
// (c:externalData r:id). An embedded .xls given a new .xlsx by Edit Data moves the chart into a new part too: its
// other relationships (style, colours, user shapes, pictures) are carried over under their ids, the workbook's id
// names the .xlsx. The frame's c:chart names the part written.

type ChartFrame = Extract<FrameRef, { kind: "chart" }>

const GRAPHIC_CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const R_URI = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const C_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const WORKBOOK_TYPES: ReadonlySet<string> = new Set([
	RELATIONSHIP_TYPES.embeddedWorkbook,
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject"
])

// The PartsApi members a chart's parts need beyond relating from the slide (types.ts, optional).
interface ChartParts extends PartsApi {
	relateFrom?(from: string, target: string, type: string, options?: { readonly external?: boolean; readonly id?: string }): string
	has?(part: string): boolean
}

interface AddOptions {
	readonly from?: string
	readonly id?: string
	readonly name?: string
}

// The source frame's a:graphic and the relationship id its c:chart names.
function sourceGraphic(context: EmitContext, shape: ShapeNode): { readonly graphic: number; readonly id: string | undefined } | undefined {
	const node = sourceNode(context, shape.src)
	const r = readerOf(context)

	if (node < 0 || r === undefined) return undefined

	const graphic = r.child(node, G.A, "graphic")

	if (graphic < 0) return undefined

	return { graphic, id: r.rel(r.child(r.child(graphic, G.A, "graphicData"), G.C, "chart"), "id") }
}

function graphicXml(prefix: string, rId: string): string {
	return (
		`<${prefix}graphic${prefix === "" ? ' xmlns="http://schemas.openxmlformats.org/drawingml/2006/main"' : ""}>` +
		`<${prefix}graphicData uri="${GRAPHIC_CHART}"><c:chart xmlns:c="${C_URI}" xmlns:r="${R_URI}" r:id="${rId}"/></${prefix}graphicData></${prefix}graphic>`
	)
}

function newFrame(shape: ShapeNode, rId: string): EmitResult {
	const xfrm = shape.xfrm

	if (xfrm === undefined) return refused("malformed", "a new chart without its box")

	return {
		kind: "markup",
		pieces: [
			`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr${attr("id", shape.id)}${attr("name", shape.name)}${attr("descr", shape.alt?.descr)}` +
				`${shape.hidden ? ' hidden="1"' : ""}${attr("title", shape.alt?.title)}/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>` +
				`<p:nvPr/></p:nvGraphicFramePr>${xfrmXml("p:xfrm", xfrm, false)}${graphicXml("a:", rId)}</p:graphicFrame>`
		]
	}
}

// Writes a version into a new chart part (with its workbook and the relationships it keeps): the part's rId from the
// emit's owner.
// `back`: the version goes back into its own home, which the package no longer has (an undo past the save that dropped
// it): under that name, its workbook under its own.
function addChart(context: EmitContext, version: HeldChart, owner: string, back = false): string {
	const parts = context.parts as ChartParts
	const lineage = version.lineage
	const workbook = versionWorkbook(version)
	// A view of its own per write: the save's changes name the entry each became by identity.
	const bytes = version.bytes.subarray(0)
	const added = parts.addPart("chart", bytes, CHART_TYPE, back && lineage.home !== undefined ? { name: lineage.home } : {})
	const workbookRel = lineage.rels.find(rel => !rel.external && WORKBOOK_TYPES.has(rel.type))

	noteChartWrite(context.deck, bytes, version.name, "chart", owner)

	for (const rel of lineage.rels) {
		if (rel === workbookRel && workbook !== undefined) continue

		parts.relateFrom?.(added.part, rel.target, rel.type, { external: rel.external, id: rel.id })
	}

	if (workbook !== undefined) {
		const options: { readonly crc32?: number } & AddOptions = {
			from: added.part,
			id: workbookRel?.id ?? INSERTED_WORKBOOK_ID,
			...(back && lineage.workbookHome !== undefined ? { name: lineage.workbookHome } : {})
		}

		const data = workbook.bytes.subarray(0)

		// An .xls stays an OLE object (an undo past the save that replaced it writes it again).
		parts.addPart(workbook.kind === "xls" ? "oleObject" : "embeddedWorkbook", data, workbook.contentType, options)
		noteChartWrite(context.deck, data, version.name, "workbook", owner)
	}

	return added.rId
}

// A duplicated frame's own chart before it has a home: written into the chart part the save copied for the frame (the
// one its c:chart names in the slide written, `id`), with the workbook copied with it; undefined when there is none.
function writeCopy(context: EmitContext, version: HeldChart, owner: string, id: string | undefined): string | undefined {
	const parts = context.parts as ChartParts
	const own = id === undefined ? undefined : parts.target(id)

	if (id === undefined || own === undefined) return undefined

	const bytes = version.bytes.subarray(0)

	if (parts.replaceCopy?.(own, bytes) !== true) return undefined

	noteChartWrite(context.deck, bytes, version.name, "chart", owner)

	const workbook = versionWorkbook(version)
	const workbookRel = version.lineage.rels.find(rel => !rel.external && WORKBOOK_TYPES.has(rel.type))
	const target = workbookRel === undefined ? undefined : parts.targetFrom?.(own, workbookRel.id)

	if (workbook !== undefined && target !== undefined) {
		const data = workbook.bytes.subarray(0)

		if (parts.replaceCopy(target, data)) noteChartWrite(context.deck, data, version.name, "workbook", owner)
	}

	return id
}

// The chart part the frame's version is in after this save: its home (written when the home holds another
// version), else a new part. The relationship id of it from the emit's owner; `id`: the one the frame's source c:chart
// names.
function writeVersion(context: EmitContext, version: HeldChart, owner: string, id: string | undefined): string | Refused {
	const parts = context.parts as ChartParts
	const lineage = version.lineage
	const home = lineage.home
	const workbook = versionWorkbook(version)
	// An embedded .xls the version replaced with an .xlsx: the chart moves into a new part (its relationship changes
	// type and target), keeping the old part for any undo.
	const converts = lineage.workbookKind === "xls" && workbook?.kind === "xlsx"

	if (home === undefined && lineage.copy === true && !converts) {
		const copied = writeCopy(context, version, owner, id)

		if (copied !== undefined) return copied
	}

	if (home === undefined || converts || !ownsHome(lineage, owner)) return addChart(context, version, owner)
	if (parts.has?.(home) === false) return addChart(context, version, owner, true)

	if (chartHeldBy(context.deck, home) !== version.name) {
		const bytes = version.bytes.subarray(0)

		if (parts.replacePart?.(home, bytes) !== true) return refused("failed", `the chart part ${home} cannot be replaced`)

		noteChartWrite(context.deck, bytes, version.name, "chart", owner)
	}

	const workbookHome = lineage.workbookHome

	if (workbookHome !== undefined && workbook !== undefined && !workbookHeld(context.deck, workbookHome, version.workbook)) {
		const data = workbook.bytes.subarray(0)

		if (parts.replacePart?.(workbookHome, data) !== true) return refused("failed", `the workbook ${workbookHome} cannot be replaced`)

		noteChartWrite(context.deck, data, version.name, "workbook", owner)
	}

	return parts.relate(home, RELATIONSHIP_TYPES.chart)
}

// The slide's relationship to the chart its frame named before (`id`) is dropped, unless another chart frame of the
// slide still names that chart: the part goes when nothing relates it (no relationship the markup no longer uses).
function unrelate(context: EmitContext, shape: ShapeNode, slide: SlideRef, id: string): void {
	const parts = context.parts as ChartParts
	const old = parts.target(id)
	const node = context.deck.nodes.get(slide)

	if (old === undefined || node === undefined) return

	const names = (shapes: readonly ShapeNode[]): boolean =>
		shapes.some(
			each =>
				(each !== shape && each.frame?.kind === "chart" && each.frame.part === old) ||
				(each.children !== undefined && names(each.children))
		)

	if (!names(node.shapes)) parts.unrelate?.(id)
}

function emitFrame(context: EmitContext, shape: ShapeNode, slide: SlideRef): EmitResult {
	const frame = shape.frame as ChartFrame

	if (!isHeldChart(frame.part)) return shapeElement(context, shape)

	const version = heldChart(context.deck, frame.part)

	if (version === undefined) return refused("stale", `the chart version ${frame.part} is not held`)

	const source = sourceGraphic(context, shape)
	const rId = writeVersion(context, version, chartOwner(slide, shape.id), source?.id)

	if (typeof rId !== "string") return rId
	if (source?.id !== undefined && source.id !== rId) unrelate(context, shape, slide, source.id)

	if (source === undefined) {
		if (sourceNode(context, shape.src) >= 0) return refused("malformed", "a chart frame without its a:graphic")

		return newFrame(shape, rId)
	}

	const element = shapeElement(context, shape)

	if (element.kind !== "markup" || source.id === rId) return element

	// The source's a:graphic (a hole of the element) replaced by one naming the part written.
	const document = context.document as XmlDocument
	const name = document.name(source.graphic)
	const prefix = name.includes(":") ? `${name.slice(0, name.indexOf(":"))}:` : ""
	let swapped = false
	const pieces: EmitPiece[] = element.pieces.map(piece => {
		if (typeof piece === "object" && !(piece instanceof Uint8Array) && piece.hole === source.graphic) {
			swapped = true

			return graphicXml(prefix, rId)
		}

		return piece
	})

	return swapped ? { kind: "markup", pieces } : refused("failed", "the chart's a:graphic was not written as its source")
}

export const emitPptxChart: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape?.frame?.kind !== "chart") return refused("failed", "A chart emit without a chart frame")

		return emitFrame(context, shape, request.slide.ref)
	}
}
