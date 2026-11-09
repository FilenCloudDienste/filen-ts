import { relationshipKind } from "../../docx/index"
import type { Relationships } from "../../opc/index"
import type { DeckTally } from "../../presentation/budget"
import { uniqueShapeIds } from "../../presentation/ids"
import type {
	Action,
	Background,
	ClrMap,
	ClrMapKey,
	FrameRef,
	HeaderFooterFlags,
	ListStyle,
	Placeholder,
	PlaceholderType,
	SchemeSlot,
	ShapeKind,
	ShapeLocks,
	ShapeNode,
	ShapeStyleRefs,
	SlideKind,
	SlideNode,
	SlideRef,
	StyleMatrixRef,
	ThemeRef
} from "../../presentation/model"
import { tooDeep, tooLarge } from "../../presentation/refusal"
import { CLR_MAP_KEYS } from "../../presentation/theme"
import type { XmlDocument } from "../../xml/index"
import { colorIn, fillOf, readListStyle, readTable, readTextBody, readXfrm, relPart, sourceRef, type ReadContext } from "./drawing"
import { readMedia, type MediaFacts } from "./media"
import { readTiming } from "./timing"
import { readTransition } from "./transition"
import { G, partReader, type PartReader } from "./xml"

// A slide, layout, master, notes slide, notes master or handout master part (ECMA-376 Part 1 §19.3) into a
// SlideNode: its own levels only (inheritance is resolved in core/presentation/inherit.ts). Geometry, fills, lines and
// effects stay in the source, reached through `src`; anything unread is kept there. A slide's timing (read/timing.ts)
// and its transition (read/transition.ts) are read whole and written back by span where unedited.

const ROOTS: Readonly<Record<string, SlideKind>> = {
	sld: "slide",
	sldLayout: "layout",
	sldMaster: "master",
	notes: "notes",
	notesMaster: "notesMaster",
	handoutMaster: "handoutMaster"
}

const PLACEHOLDER_TYPES: ReadonlySet<string> = new Set([
	"title",
	"body",
	"ctrTitle",
	"subTitle",
	"dt",
	"sldNum",
	"ftr",
	"hdr",
	"obj",
	"chart",
	"tbl",
	"clipArt",
	"dgm",
	"media",
	"sldImg",
	"pic"
])

const SCHEME_SLOTS: ReadonlySet<string> = new Set([
	"dk1",
	"lt1",
	"dk2",
	"lt2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hlink",
	"folHlink"
])

const DECORATIVE_EXT = "{C183D7F6-B498-43B3-948B-1728B52AA6E4}"

const GRAPHIC_TABLE = "http://schemas.openxmlformats.org/drawingml/2006/table"
const GRAPHIC_CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const GRAPHIC_CHART_STRICT = "http://purl.oclc.org/ooxml/drawingml/chart"
const GRAPHIC_CHARTEX = "http://schemas.microsoft.com/office/drawing/2014/chartex"
const GRAPHIC_DIAGRAM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
const GRAPHIC_DIAGRAM_STRICT = "http://purl.oclc.org/ooxml/drawingml/diagram"
const GRAPHIC_OLE = "http://schemas.openxmlformats.org/presentationml/2006/ole"
const GRAPHIC_OLE_STRICT = "http://purl.oclc.org/ooxml/presentationml/ole"

export interface SlideReadInput {
	readonly ref: SlideRef
	readonly part: string
	readonly document: XmlDocument
	readonly relationships: Relationships
	readonly epoch: number
	readonly tally: DeckTally
	readonly media: MediaFacts
	// The SlideRef of a parsed or listed part (layouts, masters, notes masters, slides), by part name.
	refOf(part: string): SlideRef | undefined
	themeOf(part: string): ThemeRef | undefined
	action(reader: PartReader, relationships: Relationships, node: number): Action | undefined
	// The preview part of a PowerPoint 2007-style OLE object (in the part's legacy VML drawing), by its spid.
	legacyPreview?(spid: string): string | undefined
	// Whether a chartex part the slide relates draws (chartexDrawable); absent when it relates none.
	chartex?(part: string): boolean
}

export interface SlideRead {
	readonly node: SlideNode
	readonly malformed: boolean
	// cNvPr ids written twice and reassigned.
	readonly reassignedIds: number
	// The notes slide part of a slide, when it has one.
	readonly notesPart: string | undefined
}

function clrMapOf(r: PartReader, node: number): ClrMap | undefined {
	if (node < 0) return undefined

	const out: Partial<Record<ClrMapKey, SchemeSlot>> = {}

	for (const key of CLR_MAP_KEYS) {
		const value = r.attr(node, key)

		out[key] = (value !== undefined && SCHEME_SLOTS.has(value) ? value : key.replace(/^bg/u, "lt").replace(/^tx/u, "dk")) as SchemeSlot
	}

	return out as ClrMap
}

function hfOf(r: PartReader, node: number): HeaderFooterFlags | undefined {
	if (node < 0) return undefined

	return {
		sldNum: r.bool(node, "sldNum") ?? true,
		hdr: r.bool(node, "hdr") ?? true,
		ftr: r.bool(node, "ftr") ?? true,
		dt: r.bool(node, "dt") ?? true
	}
}

function backgroundOf(context: ReadContext, bg: number): Background | undefined {
	const r = context.reader

	if (bg < 0) return undefined

	const bgPr = r.child(bg, G.P, "bgPr")

	if (bgPr >= 0) {
		const fill = fillOf(context, bgPr)
		const shade = r.bool(bgPr, "shadeToTitle")

		// A bgPr with noFill paints nothing: the slide shows white (no master background shows through).
		return {
			kind: "fill",
			fill:
				fill === undefined || fill === "none"
					? { kind: "solid", color: { kind: "srgb", rgb: "FFFFFF", mods: [{ name: "alpha", value: 0 }] } }
					: fill,
			...(shade === undefined ? {} : { shadeToTitle: shade }),
			src: sourceRef(context, bgPr)
		}
	}

	const bgRef = r.child(bg, G.P, "bgRef")

	if (bgRef >= 0) {
		const color = colorIn(r, bgRef)

		return { kind: "ref", idx: r.int(bgRef, "idx") ?? 0, ...(color === undefined ? {} : { color }), src: sourceRef(context, bgRef) }
	}

	return undefined
}

function matrixRef(r: PartReader, node: number): StyleMatrixRef {
	const color = colorIn(r, node)

	return { idx: r.int(node, "idx") ?? 0, ...(color === undefined ? {} : { color }) }
}

export function styleOf(r: PartReader, node: number): ShapeStyleRefs | undefined {
	if (node < 0) return undefined

	const font = r.child(node, G.A, "fontRef")
	const idx = r.attr(font, "idx")
	const fontColor = colorIn(r, font)

	return {
		ln: matrixRef(r, r.child(node, G.A, "lnRef")),
		fill: matrixRef(r, r.child(node, G.A, "fillRef")),
		effect: matrixRef(r, r.child(node, G.A, "effectRef")),
		font: { idx: idx === "major" || idx === "minor" ? idx : "none", ...(fontColor === undefined ? {} : { color: fontColor }) }
	}
}

function placeholderOf(r: PartReader, nvPr: number): Placeholder | undefined {
	const ph = r.child(nvPr, G.P, "ph")

	if (ph < 0) return undefined

	const type = r.attr(ph, "type") ?? "obj"
	const orient = r.attr(ph, "orient")
	const sz = r.attr(ph, "sz")
	const custom = r.bool(ph, "hasCustomPrompt")

	return {
		// ECMA-376 §19.3.1.36: type defaults to obj, idx to 0.
		type: (PLACEHOLDER_TYPES.has(type) ? type : "obj") as PlaceholderType,
		idx: Math.max(0, r.int(ph, "idx") ?? 0),
		...(r.int(ph, "idx") === undefined ? {} : { idxWritten: true as const }),
		...(r.attr(ph, "type") === "obj" ? { typeWritten: true as const } : {}),
		...(orient === "horz" || orient === "vert" ? { orient } : {}),
		...(sz === "full" || sz === "half" || sz === "quarter" ? { sz } : {}),
		...(custom === undefined ? {} : { hasCustomPrompt: custom })
	}
}

// The cNv*Pr element of a shape's non-visual properties and the locks element it may hold (ECMA-376 Part 1
// §20.1.2.2: a:spLocks, a:cxnSpLocks, a:picLocks, a:grpSpLocks, a:graphicFrameLocks).
const LOCK_ELEMENTS: readonly (readonly [string, string])[] = [
	["cNvSpPr", "spLocks"],
	["cNvCxnSpPr", "cxnSpLocks"],
	["cNvPicPr", "picLocks"],
	["cNvGrpSpPr", "grpSpLocks"],
	["cNvGraphicFramePr", "graphicFrameLocks"]
]
const LOCK_FLAGS: readonly (keyof ShapeLocks)[] = ["noGrp", "noUngrp", "noSelect", "noRot", "noChangeAspect", "noMove", "noResize"]

// The file's own locks on a shape (what the editor should not let the user change), absent when it sets none.
function lockedBy(r: PartReader, nv: number, nvGroup: G): { locks?: ShapeLocks } {
	for (const [cNv, name] of LOCK_ELEMENTS) {
		const holder = r.child(nv, nvGroup, cNv)

		if (holder < 0) continue

		const element = r.child(holder, G.A, name)

		if (element < 0) return {}

		let locks: Record<string, true> | undefined

		for (const flag of LOCK_FLAGS) {
			if (r.bool(element, flag) !== true) continue

			locks ??= {}
			locks[flag] = true
		}

		return locks === undefined ? {} : { locks: Object.freeze(locks) }
	}

	return {}
}

class ShapeReader {
	private readonly context: ReadContext
	private readonly input: SlideReadInput
	private count = 0

	constructor(context: ReadContext, input: SlideReadInput) {
		this.context = context
		this.input = input
	}

	private counted(): void {
		const budget = this.context.tally.budgets.shapesPerSlide

		if (++this.count > budget) tooLarge("shapes on a slide", budget)
	}

	tree(node: number, depth: number, locked: boolean): ShapeNode[] {
		const budgets = this.context.tally.budgets

		if (depth > budgets.groupDepth) tooDeep("group nesting", budgets.groupDepth)

		const r = this.context.reader
		const out: ShapeNode[] = []

		for (let child = r.first(node); child >= 0; child = r.next(child)) {
			const group = r.group(child)
			const local = r.local(child)

			if (group === G.MC && local === "AlternateContent") {
				const branch = this.branch(child)

				if (branch >= 0) {
					for (const shape of this.tree(branch, depth, true)) out.push(shape)
				} else {
					this.counted()
					out.push({
						id: 0,
						name: "",
						hidden: false,
						kind: "opaque",
						src: sourceRef(this.context, child),
						lock: "alternateContent"
					})
				}

				continue
			}

			if (group !== G.P && group !== G.P14) continue

			const shape = this.shape(child, local, depth)

			if (shape === undefined) continue
			if (locked && shape.lock === undefined) shape.lock = "alternateContent"

			out.push(shape)
		}

		return out
	}

	// The branch of a shape-level mc:AlternateContent: a chartex Choice (Office 2016 charts) when every cx:chart in it
	// names a part that draws, else the one alternate() reads.
	private branch(node: number): number {
		const r = this.context.reader
		const branch = r.alternate(node)
		const draws = this.input.chartex

		if (draws === undefined) return branch

		const choice = r.alternateChartex(node)

		if (choice < 0 || choice === branch || !r.is(choice, G.MC, "Choice")) return branch

		const document = r.document
		const end = document.end(choice)
		let charts = 0

		for (let at = choice + 1; at < document.count && document.start(at) < end; at++) {
			if (!r.is(at, G.Cx, "chart")) continue

			const part = relPart(this.context, r.rel(at, "id"))

			if (part === undefined || !draws(part)) return branch

			charts++
		}

		return charts > 0 ? choice : branch
	}

	private shape(node: number, local: string, depth: number): ShapeNode | undefined {
		const r = this.context.reader

		switch (local) {
			case "sp":
				return this.common(node, "sp", r.child(node, G.P, "nvSpPr"), r.child(r.child(node, G.P, "spPr"), G.A, "xfrm"))
			case "cxnSp":
				return this.common(node, "cxnSp", r.child(node, G.P, "nvCxnSpPr"), r.child(r.child(node, G.P, "spPr"), G.A, "xfrm"))
			case "pic":
				return this.common(node, "pic", r.child(node, G.P, "nvPicPr"), r.child(r.child(node, G.P, "spPr"), G.A, "xfrm"))
			case "grpSp": {
				const shape = this.common(
					node,
					"grpSp",
					r.child(node, G.P, "nvGrpSpPr"),
					r.child(r.child(node, G.P, "grpSpPr"), G.A, "xfrm")
				)

				shape.children = this.tree(node, depth + 1, false)

				return shape
			}
			case "graphicFrame":
				return this.common(node, "frame", r.child(node, G.P, "nvGraphicFramePr"), r.child(node, G.P, "xfrm"))
			case "contentPart": {
				// PowerPoint 2010 writes p14:nvContentPartPr and p14:xfrm inside p:contentPart.
				const p14 = r.child(node, G.P14, "nvContentPartPr") >= 0
				const nv = p14 ? r.child(node, G.P14, "nvContentPartPr") : r.child(node, G.P, "nvContentPartPr")
				const xfrm = r.child(node, p14 ? G.P14 : G.P, "xfrm")

				return this.common(node, "ink", nv, xfrm, p14 ? G.P14 : G.P)
			}
			case "nvGrpSpPr":
			case "grpSpPr":
			case "extLst":
				return undefined
			default: {
				this.counted()

				return { id: 0, name: "", hidden: false, kind: "opaque", src: sourceRef(this.context, node) }
			}
		}
	}

	private common(node: number, kind: ShapeKind, nv: number, xfrmNode: number, nvGroup: G = G.P): ShapeNode {
		this.counted()

		const context = this.context
		const r = context.reader
		const cNvPr = r.child(nv, nvGroup, "cNvPr")
		const nvPr = r.child(nv, nvGroup, "nvPr")
		const descr = r.attr(cNvPr, "descr")
		const title = r.attr(cNvPr, "title")
		const decorative = this.decorative(cNvPr)
		const ph = placeholderOf(r, nvPr)
		const xfrm = readXfrm(r, xfrmNode)
		const click = r.child(cNvPr, G.A, "hlinkClick")
		const hover = r.child(cNvPr, G.A, "hlinkHover")
		const clickAction = click < 0 ? undefined : context.action(click)
		const hoverAction = hover < 0 ? undefined : context.action(hover)
		const style = styleOf(r, r.child(node, G.P, "style"))
		const shape: ShapeNode = {
			id: r.int(cNvPr, "id") ?? 0,
			name: r.attr(cNvPr, "name") ?? "",
			...(descr !== undefined || title !== undefined || decorative
				? {
						alt: {
							...(descr === undefined ? {} : { descr }),
							...(title === undefined ? {} : { title }),
							...(decorative ? { decorative } : {})
						}
					}
				: {}),
			hidden: r.bool(cNvPr, "hidden") ?? false,
			kind,
			...(ph === undefined ? {} : { ph }),
			...(kind === "sp" && r.bool(r.child(nv, nvGroup, "cNvSpPr"), "txBox") === true ? { txBox: true as const } : {}),
			...lockedBy(r, nv, nvGroup),
			...(xfrm === undefined ? {} : { xfrm }),
			...(style === undefined ? {} : { style }),
			...(clickAction !== undefined || hoverAction !== undefined
				? {
						actions: {
							...(clickAction === undefined ? {} : { click: clickAction }),
							...(hoverAction === undefined ? {} : { hover: hoverAction })
						}
					}
				: {}),
			src: sourceRef(context, node)
		}

		const txBody = r.child(node, G.P, "txBody")

		if (txBody >= 0) shape.text = readTextBody(context, txBody)

		if (kind === "pic") {
			const poster = relPart(context, r.rel(r.child(r.child(node, G.P, "blipFill"), G.A, "blip"), "embed"))
			const media = readMedia(context, nvPr, this.input.media, poster)

			if (media !== undefined) shape.media = media
		}

		if (kind === "frame") {
			const frame = this.frame(node)

			shape.frame = frame

			if (frame.kind === "unknown") shape.lock = "unknownFrame"
		}

		return shape
	}

	private decorative(cNvPr: number): boolean {
		const r = this.context.reader

		for (const ext of r.children(r.child(cNvPr, G.A, "extLst"), G.A, "ext")) {
			if (r.attr(ext, "uri") === DECORATIVE_EXT) return r.bool(r.child(ext, G.Adec, "decorative"), "val") ?? false
		}

		return false
	}

	private frame(node: number): FrameRef {
		const context = this.context
		const r = context.reader
		const graphicData = r.child(r.child(node, G.A, "graphic"), G.A, "graphicData")
		const uri = r.attr(graphicData, "uri") ?? ""
		let data = graphicData

		// Content inside an mc:AlternateContent of the graphicData (chartex, OLE): the branch we read.
		for (let child = r.first(graphicData); child >= 0; child = r.next(child)) {
			if (r.is(child, G.MC, "AlternateContent")) {
				const branch = r.alternate(child)

				if (branch >= 0) data = branch

				break
			}
		}

		switch (uri) {
			case GRAPHIC_TABLE: {
				const tbl = r.child(graphicData, G.A, "tbl")

				return tbl < 0 ? { kind: "unknown", src: sourceRef(context, node) } : { kind: "table", table: readTable(context, tbl) }
			}
			case GRAPHIC_CHART:
			case GRAPHIC_CHART_STRICT: {
				const part = relPart(context, r.rel(r.child(graphicData, G.C, "chart"), "id"))

				return part === undefined ? { kind: "unknown", src: sourceRef(context, node) } : { kind: "chart", part }
			}
			case GRAPHIC_CHARTEX: {
				const part = relPart(context, r.rel(r.child(data, G.Cx, "chart"), "id"))

				return part === undefined ? { kind: "unknown", src: sourceRef(context, node) } : { kind: "chart", part }
			}
			case GRAPHIC_DIAGRAM:
			case GRAPHIC_DIAGRAM_STRICT: {
				const ids = r.child(graphicData, G.Dgm, "relIds")
				const parts = ["dm", "lo", "qs", "cs"].map(name => relPart(context, r.rel(ids, name)))
				const [data0, layout, style, colors] = parts

				if (data0 === undefined) return { kind: "unknown", src: sourceRef(context, node) }

				return { kind: "smartart", data: data0, layout: layout ?? "", style: style ?? "", colors: colors ?? "" }
			}
			case GRAPHIC_OLE:
			case GRAPHIC_OLE_STRICT: {
				const ole = r.child(data, G.P, "oleObj")
				const part = relPart(context, r.rel(ole, "id"))
				const spid = r.attr(ole, "spid")
				const preview =
					relPart(context, r.rel(r.child(r.child(r.child(ole, G.P, "pic"), G.P, "blipFill"), G.A, "blip"), "embed")) ??
					(spid === undefined ? undefined : this.input.legacyPreview?.(spid))

				return {
					kind: "ole",
					progId: r.attr(ole, "progId") ?? "",
					...(part === undefined ? {} : { part }),
					...(preview === undefined ? {} : { preview })
				}
			}
			default:
				return { kind: "unknown", src: sourceRef(context, node) }
		}
	}
}

const EMPTY_LIST: ListStyle = { levels: [] }

export function readSlidePart(input: SlideReadInput): SlideRead {
	const document = input.document
	const r = partReader(document)
	const root = document.documentElement()
	const kind = r.group(root) === G.P ? ROOTS[r.local(root)] : undefined

	if (kind === undefined) throw new SlidePartError(`${input.part} is not a presentation slide part`)

	const context: ReadContext = {
		reader: r,
		part: input.part,
		epoch: input.epoch,
		relationships: input.relationships,
		tally: input.tally,
		action: node => input.action(r, input.relationships, node)
	}
	const cSld = r.child(root, G.P, "cSld")
	const spTree = r.child(cSld, G.P, "spTree")
	const shapes = new ShapeReader(context, input).tree(spTree, 0, false)
	const rootId = r.int(r.child(r.child(spTree, G.P, "nvGrpSpPr"), G.P, "cNvPr"), "id")
	const reassignedIds = uniqueShapeIds(shapes, rootId === undefined ? [] : [rootId])
	const related = (type: string): string | undefined => {
		for (const relationship of input.relationships.all) {
			if (!relationship.external && relationship.partName !== undefined && relationshipKind(relationship.type) === type) {
				return `/${relationship.partName}`
			}
		}

		return undefined
	}
	const parentPart =
		kind === "slide"
			? related("slideLayout")
			: kind === "layout"
				? related("slideMaster")
				: kind === "notes"
					? related("notesMaster")
					: undefined
	const parent = parentPart === undefined ? undefined : input.refOf(parentPart)
	const themePart = kind === "master" || kind === "notesMaster" || kind === "handoutMaster" ? related("theme") : undefined
	const theme = themePart === undefined ? undefined : input.themeOf(themePart)
	const name = r.attr(cSld, "name")
	const background = backgroundOf(context, r.child(cSld, G.P, "bg"))
	const clrMap = clrMapOf(r, r.child(root, G.P, "clrMap"))
	const ovr = r.child(root, G.P, "clrMapOvr")
	const override = r.child(ovr, G.A, "overrideClrMapping")
	const hf = hfOf(r, r.child(root, G.P, "hf"))
	const layoutType = kind === "layout" ? (r.attr(root, "type") ?? "cust") : undefined
	let txStyles: SlideNode["txStyles"]

	if (kind === "master") {
		const styles = r.child(root, G.P, "txStyles")
		const list = (local: string): ListStyle => {
			const node = r.child(styles, G.P, local)

			return node < 0 ? EMPTY_LIST : readListStyle(context, node)
		}

		txStyles = { title: list("titleStyle"), body: list("bodyStyle"), other: list("otherStyle") }
	} else if (kind === "notesMaster") {
		// The notes master has one list style for the notes body (§19.3.1.28).
		const notesStyle = r.child(root, G.P, "notesStyle")

		txStyles = { title: EMPTY_LIST, body: notesStyle < 0 ? EMPTY_LIST : readListStyle(context, notesStyle), other: EMPTY_LIST }
	}

	// Only a slide's timing plays (layouts and masters keep theirs as source).
	const timing =
		kind === "slide"
			? readTiming({ reader: r, part: input.part, epoch: input.epoch, budgets: input.tally.budgets.timing }, root)
			: undefined
	const transition = kind === "slide" ? readTransition(context, root) : undefined
	const node: SlideNode = {
		ref: input.ref,
		kind,
		part: input.part,
		src: sourceRef(context, root),
		...(name === undefined ? {} : { name }),
		...(parent === undefined ? {} : { parent }),
		...(clrMap === undefined ? {} : { clrMap }),
		...(ovr < 0 ? {} : { clrMapOvr: override < 0 ? "master" : (clrMapOf(r, override) ?? "master") }),
		...(theme === undefined ? {} : { theme }),
		...(background === undefined ? {} : { background }),
		// showMasterSp (§19.3.1.38/.39) defaults to true; masters always show their own shapes.
		showMasterShapes: kind === "slide" || kind === "layout" ? (r.bool(root, "showMasterSp") ?? true) : true,
		// p:sld show="0" (§19.3.1.38) hides the slide in the show.
		hidden: kind === "slide" ? r.bool(root, "show") === false : false,
		...(layoutType === undefined ? {} : { layoutType }),
		...(txStyles === undefined ? {} : { txStyles }),
		...(hf === undefined ? {} : { hf }),
		shapes,
		...(timing === undefined ? {} : { timing }),
		...(transition === undefined ? {} : { transition }),
		comments: [],
		revision: 0
	}

	return {
		node,
		malformed: r.malformed,
		reassignedIds,
		notesPart: kind === "slide" ? related("notesSlide") : undefined
	}
}

export class SlidePartError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SlidePartError"
	}
}
