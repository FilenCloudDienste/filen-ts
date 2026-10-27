import { NO_PROPERTIES, parseLength, type OdfListStyle, type OdfProperties } from "../../odf/index"
import { Evaluator, GeometryError, enhancedPath, pointsPath, svgPath, type SubPath } from "../../odt/geometry"
import { classifyHref } from "../../presentation/actions"
import type { PictureAdjust } from "../../presentation/edit/ops"
import { tooDeep, tooLarge } from "../../presentation/refusal"
import {
	PATH_CLOSE,
	PATH_CUBIC,
	PATH_LINE,
	PATH_MOVE,
	type Action,
	type CustomPath,
	type FillProps,
	type FrameRef,
	type Geometry,
	type LineProps,
	type ListStyle,
	type MediaRef,
	type PlaceholderType,
	type ShapeLocks,
	type ShapeNode,
	type ShapePropsEdit,
	type TableCell,
	type TableCellProps,
	type TableModel,
	type TableRow,
	type Xfrm
} from "../../presentation/model"
import { NodeKind } from "../../xml/index"
import { overlay, type Fragment, type OdpContext } from "./context"
import { EMU_PER_PT, bodyPrOf, effectsOf, fillOf, lineOf, packagePart, srgb } from "./fills"
import { asianSizeOf, embeddedListStyle, levelStyle, listStyleOf, readTextBody, type TextScope } from "./text"

// The shapes of a drawing page, master page or notes page (ODF 1.3 Part 3 §10.3 frames, §10.4 shapes, §10.5
// custom shapes, §10.9 groups) as the model's shape nodes, back to front. Positions and sizes become EMU boxes:
// svg:x/y/width/height, then draw:transform (§19.229: its transforms are applied in the order written, LibreOffice's
// "rotate (a) translate (x y)" turns the box about its corner, then places it) taken apart into DrawingML's offset,
// extent and clockwise rotation about the centre. Custom geometry (enhanced paths, SVG paths, points) is evaluated
// by the ODT engine's geometry (core/odt/geometry.ts) into custom paths.
//
// Placeholder boxes (§19.431 presentation:user-transformed): "false" takes the master's presentation shape of the
// same class (where ODF is explicit, ODF wins); absent, the shape's own box when it writes one, else the master's.
// Measured over UNO on the frozen corpus: of 108 presentation shapes without the attribute whose own box differs from
// their master's, LibreOffice 7.5 places 102 at their own box; the 6 others (one deck's titles, own width wider than
// the slide) keep the master's width. No corpus file writes "false".

export const CLASS_TYPES: Readonly<Record<string, PlaceholderType>> = {
	title: "title",
	outline: "body",
	subtitle: "subTitle",
	graphic: "pic",
	object: "obj",
	chart: "chart",
	table: "tbl",
	orgchart: "dgm",
	page: "sldImg",
	notes: "body",
	header: "hdr",
	footer: "ftr",
	"date-time": "dt",
	"page-number": "sldNum",
	handout: "sldImg"
}

const MAX_GROUP_DEPTH = 128

// A draw:custom-shape type with no enhanced path (§19.145 leaves the outline to the type) as a DrawingML preset.
const PRESETS: Readonly<Record<string, string>> = {
	rectangle: "rect",
	ellipse: "ellipse",
	"round-rectangle": "roundRect",
	"isosceles-triangle": "triangle",
	"right-triangle": "rtTriangle",
	parallelogram: "parallelogram",
	trapezoid: "trapezoid",
	diamond: "diamond",
	hexagon: "hexagon",
	octagon: "octagon",
	pentagon: "pentagon",
	star5: "star5",
	"right-arrow": "rightArrow",
	"left-arrow": "leftArrow",
	"up-arrow": "upArrow",
	"down-arrow": "downArrow",
	cloud: "cloud",
	heart: "heart",
	smiley: "smileyFace",
	ring: "donut",
	cross: "plus",
	frame: "frame"
}

// What the shapes of one page are read with.
export interface ShapeScope {
	readonly fragment: Fragment
	readonly text: Omit<TextScope, "fragment" | "listStyle">
	// The master's presentation shapes by class (their boxes, for placeholders that do not place themselves).
	readonly masterBoxes: ReadonlyMap<string, Xfrm>
	// Allocates the page's shape ids (unique per page).
	nextId(): number
	// Pictures and objects the shapes name, read ahead before the page renders.
	readonly images: Set<string>
	readonly charts: Set<string>
	// Pictures cut by fo:clip (§20.180: top, right, bottom, left of the picture's own size), made fractions once the
	// picture's size is read.
	readonly clips: { readonly shape: ShapeNode; readonly part: string; readonly clip: readonly [number, number, number, number] }[]
	// A shape kept in the source the reader did not model (a form control); counted for the report.
	unread: number
	// The master page whose presentation styles the page's presentation objects use (its style:name).
	readonly masterName?: string
}

interface Box {
	x: number
	y: number
	w: number
	h: number
}

type Matrix = [number, number, number, number, number, number]

function multiply(m: Matrix, n: Matrix): Matrix {
	// m after n.
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5]
	]
}

// draw:transform as one matrix (points), the transforms applied in the order written.
function transformMatrix(transform: string): Matrix | undefined {
	let out: Matrix = [1, 0, 0, 1, 0, 0]
	const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/gu
	let found = false

	for (const match of transform.matchAll(pattern)) {
		const name = (match[1] ?? "").toLowerCase()
		const args = (match[2] ?? "")
			.trim()
			.split(/[\s,]+/u)
			.filter(item => item !== "")
		let step: Matrix | undefined

		switch (name) {
			case "rotate": {
				const angle = Number(args[0] ?? "0")

				if (!Number.isFinite(angle)) return undefined

				// Counter-clockwise on the page (y down): x' = x cos + y sin, y' = −x sin + y cos.
				step = [Math.cos(angle), -Math.sin(angle), Math.sin(angle), Math.cos(angle), 0, 0]
				break
			}
			case "translate": {
				const x = parseLength(args[0]) ?? (Number(args[0] ?? "0") / 1000 / 2.54) * 72
				const y = parseLength(args[1] ?? "0") ?? (Number(args[1] ?? "0") / 1000 / 2.54) * 72

				step = [1, 0, 0, 1, Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0]
				break
			}
			case "scale": {
				const sx = Number(args[0] ?? "1")
				const sy = Number(args[1] ?? args[0] ?? "1")

				step = [Number.isFinite(sx) ? sx : 1, 0, 0, Number.isFinite(sy) ? sy : 1, 0, 0]
				break
			}
			case "skewx": {
				const angle = Number(args[0] ?? "0")

				step = [1, 0, Number.isFinite(angle) ? Math.tan(angle) : 0, 1, 0, 0]
				break
			}
			case "skewy": {
				const angle = Number(args[0] ?? "0")

				step = [1, Number.isFinite(angle) ? Math.tan(angle) : 0, 0, 1, 0, 0]
				break
			}
			case "matrix": {
				const values = args.map(arg => parseLength(arg) ?? Number(arg))

				if (values.length === 6 && values.every(Number.isFinite)) step = values as Matrix
				break
			}
			default:
				break
		}

		if (step !== undefined) {
			out = multiply(step, out)
			found = true
		}
	}

	return found ? out : undefined
}

// An EMU box from a box in points and an optional transform: DrawingML's offset and extent of the unrotated box and
// its clockwise rotation about the centre.
function xfrmOf(box: Box, matrix: Matrix | undefined, flipH = false, flipV = false): Xfrm {
	if (matrix === undefined) {
		return {
			x: Math.round(box.x * EMU_PER_PT),
			y: Math.round(box.y * EMU_PER_PT),
			cx: Math.round(Math.max(0, box.w) * EMU_PER_PT),
			cy: Math.round(Math.max(0, box.h) * EMU_PER_PT),
			rot: 0,
			flipH,
			flipV
		}
	}

	// The box's own scale (a "scale" step, or a mirror) folded into its size and flips.
	const sx = Math.hypot(matrix[0], matrix[1])
	const sy = Math.hypot(matrix[2], matrix[3])
	const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2]
	const w = box.w * sx
	const h = box.h * sy
	const centerX = matrix[0] * (box.x + box.w / 2) + matrix[2] * (box.y + box.h / 2) + matrix[4]
	const centerY = matrix[1] * (box.x + box.w / 2) + matrix[3] * (box.y + box.h / 2) + matrix[5]
	let degrees = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI
	let mirrored = flipV

	if (determinant < 0) {
		// A mirror: a vertical flip of the box turned by the angle.
		mirrored = !mirrored
		degrees = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI
	}

	degrees = ((degrees % 360) + 360) % 360

	return {
		x: Math.round((centerX - w / 2) * EMU_PER_PT),
		y: Math.round((centerY - h / 2) * EMU_PER_PT),
		cx: Math.round(Math.max(0, w) * EMU_PER_PT),
		cy: Math.round(Math.max(0, h) * EMU_PER_PT),
		rot: Math.round(degrees * 60_000) % 21_600_000,
		flipH,
		flipV: mirrored
	}
}

function boxOf(attributes: ReadonlyMap<string, string>): Box {
	return {
		x: parseLength(attributes.get("svg:x")) ?? 0,
		y: parseLength(attributes.get("svg:y")) ?? 0,
		w: parseLength(attributes.get("svg:width")) ?? 0,
		h: parseLength(attributes.get("svg:height")) ?? 0
	}
}

function viewBoxOf(
	value: string | undefined,
	fallback: { readonly w: number; readonly h: number }
): { left: number; top: number; width: number; height: number } {
	const numbers = (value ?? "")
		.trim()
		.split(/[\s,]+/u)
		.map(Number)

	if (numbers.length === 4 && numbers.every(Number.isFinite) && (numbers[2] ?? 0) > 0 && (numbers[3] ?? 0) > 0)
		return { left: numbers[0] ?? 0, top: numbers[1] ?? 0, width: numbers[2] ?? 1, height: numbers[3] ?? 1 }

	return { left: 0, top: 0, width: Math.max(fallback.w, 1e-6), height: Math.max(fallback.h, 1e-6) }
}

// Evaluated sub-paths in a view box as the model's custom paths (integer path spaces of at most 100,000).
function customPaths(
	context: OdpContext,
	paths: readonly SubPath[],
	viewBox: { left: number; top: number; width: number; height: number },
	mirrorX: boolean,
	mirrorY: boolean
): CustomPath[] {
	const scale = 100_000 / Math.max(viewBox.width, viewBox.height, 1e-9)
	const w = Math.max(1, Math.round(viewBox.width * scale))
	const h = Math.max(1, Math.round(viewBox.height * scale))
	const out: CustomPath[] = []
	let total = 0

	for (const path of paths) {
		if (path.segments.length === 0) continue

		const commands: number[] = []
		const coords: number[] = []
		const point = (x: number, y: number): void => {
			let px = (x - viewBox.left) * scale
			let py = (y - viewBox.top) * scale

			if (mirrorX) px = w - px
			if (mirrorY) py = h - py

			coords.push(Number.isFinite(px) ? px : 0, Number.isFinite(py) ? py : 0)
		}

		for (const segment of path.segments) {
			switch (segment.kind) {
				case "M":
					commands.push(PATH_MOVE)
					point(segment.x, segment.y)
					break
				case "L":
					commands.push(PATH_LINE)
					point(segment.x, segment.y)
					break
				case "C":
					commands.push(PATH_CUBIC)
					point(segment.x1, segment.y1)
					point(segment.x2, segment.y2)
					point(segment.x, segment.y)
					break
				case "Z":
					commands.push(PATH_CLOSE)
			}
		}

		total += commands.length

		if (total > context.budgets.pathCommandsPerShape) tooLarge("path commands in a shape", context.budgets.pathCommandsPerShape)

		out.push({
			w,
			h,
			fill: path.fill ? "norm" : "none",
			stroke: path.stroke,
			extrusionOk: false,
			commands: Uint8Array.from(commands),
			coords: Float64Array.from(coords)
		})
	}

	return out
}

const RECT: Geometry = { kind: "preset", preset: "rect", guides: [] }

interface ShapeStyle {
	readonly graphic: OdfProperties
	readonly paragraph: OdfProperties
	readonly text: OdfProperties
}

// The master's presentation style a class of presentation object uses ("<master>-title", "-subtitle", "-outline1",
// "-notes"; LibreOffice's names, §16.4).
const CLASS_STYLES: Readonly<Record<string, string>> = { title: "title", subtitle: "subtitle", outline: "outline1", notes: "notes" }

function masterStyleOf(context: OdpContext, master: string | undefined, presentationClass: string | undefined): string | undefined {
	const suffix = presentationClass === undefined ? undefined : CLASS_STYLES[presentationClass]

	if (suffix === undefined) return undefined

	// A master without styles of its own (a file that names styles it does not write) takes LibreOffice's default
	// master's, else the first master's that has them.
	const candidates = [
		...(master === undefined ? [] : [`${master}-${suffix}`]),
		`Default-${suffix}`,
		...context.sheet.masterOrder.map(name => `${name}-${suffix}`)
	]

	return candidates.find(name => context.hasPresentationStyle(name))
}

function styleOf(context: OdpContext, fragment: Fragment, attributes: ReadonlyMap<string, string>, base: string | undefined): ShapeStyle {
	const graphic = attributes.get("draw:style-name")
	const presentation = attributes.get("presentation:style-name")
	const scope = fragment.scope

	return {
		graphic: overlay(
			context.shapeProperties(graphic, presentation, scope, "graphic", base),
			context.shapeProperties(graphic, presentation, scope, "loext:graphic", base)
		),
		paragraph: context.shapeProperties(graphic, presentation, scope, "paragraph", base),
		text: context.shapeProperties(graphic, presentation, scope, "text", base)
	}
}

// style:protect (ODF 1.3 §20.351, a space-separated list of content, position and size, or none) as the shape's locks:
// a protected position also stops turning (LibreOffice offers no rotation for it), a protected size stops resizing.
function protectionOf(value: string | undefined): ShapeLocks | undefined {
	if (value === undefined) return undefined

	const tokens = value.trim().split(/\s+/u)
	const position = tokens.includes("position")
	const size = tokens.includes("size")

	if (!position && !size) return undefined

	return Object.freeze({
		...(position ? { noMove: true as const, noRot: true as const } : {}),
		...(size ? { noResize: true as const } : {})
	})
}

// An empty presentation object (presentation:placeholder="true", §19.418) is a prompt, drawn by neither LibreOffice
// nor PowerPoint outside editing: its fill, line and shadow stay in the source and are not painted.
function graphicProps(
	context: OdpContext,
	style: ShapeStyle,
	empty: boolean,
	geometry: Geometry | undefined,
	picture: boolean
): ShapePropsEdit {
	if (empty) return { ...(geometry === undefined ? {} : { geometry }), fill: "none", ln: "none" }

	const resources = context.sheet.drawResources
	const fill = picture ? undefined : fillOf(style.graphic, resources)
	const ln = lineOf(style.graphic, resources)
	const effects = effectsOf(style.graphic)

	return {
		...(geometry === undefined ? {} : { geometry }),
		...(fill === undefined ? {} : { fill }),
		...(ln === undefined ? {} : { ln }),
		...(effects === undefined ? {} : { effects })
	}
}

// The levels of a shape's text: outline objects from their master's outline styles, every other shape from its
// own style at every level.
// The levels of a shape's text: outline objects from their master's outline styles ("-outline1"…"-outline9"),
// their own automatic style's attributes over each, every other shape from its own style at every level.
function textLevels(
	context: OdpContext,
	fragment: Fragment,
	attributes: ReadonlyMap<string, string>,
	style: ShapeStyle,
	outline: string | undefined
): { readonly lstStyle: ListStyle; readonly listStyle: OdfListStyle | undefined } {
	const presentation = attributes.get("presentation:style-name")
	const listOf = (graphic: OdfProperties): OdfListStyle | undefined =>
		embeddedListStyle(graphic.children.find(child => child.name === "text:list-style"))
	const chain = presentation === undefined ? [] : context.resolver.resolve("presentation", presentation, fragment.scope).chain
	const inherited = [...chain].reverse().find(item => !item.isDefault && !item.automatic && /outline1$/u.test(item.name))?.name
	const first = outline ?? inherited

	if (first !== undefined) {
		const prefix = first.slice(0, -1)
		const own = chain[chain.length - 1]
		const automatic = own?.automatic === true && presentation !== undefined ? presentation : undefined
		const graphic = attributes.get("draw:style-name")
		const levels = Array.from({ length: 9 }, (_, at) => {
			const name = `${prefix}${String(at + 1)}`
			const base = context.hasPresentationStyle(name) ? name : first
			const paragraph = overlay(
				context.shapeProperties(graphic, undefined, fragment.scope, "paragraph", base),
				automatic === undefined ? NO_PROPERTIES : context.ownOnly(automatic, fragment.scope, "paragraph")
			)
			const text = overlay(
				context.shapeProperties(graphic, undefined, fragment.scope, "text", base),
				automatic === undefined ? NO_PROPERTIES : context.ownOnly(automatic, fragment.scope, "text")
			)

			return levelStyle(paragraph, text, context)
		})

		return {
			lstStyle: listStyleOf(levels),
			listStyle: listOf(style.graphic) ?? listOf(context.shapeProperties(undefined, undefined, fragment.scope, "graphic", first))
		}
	}

	return { lstStyle: listStyleOf([levelStyle(style.paragraph, style.text, context)]), listStyle: listOf(style.graphic) }
}

function eventAction(context: OdpContext, fragment: Fragment, node: number): Action | undefined {
	const document = fragment.document

	for (let listeners = document.firstChildElement(node); listeners >= 0; listeners = document.nextSiblingElement(listeners)) {
		if (fragment.name(listeners) !== "office:event-listeners") continue

		for (let listener = document.firstChildElement(listeners); listener >= 0; listener = document.nextSiblingElement(listener)) {
			const name = fragment.name(listener)
			const attributes = fragment.attributes(listener)
			const event = attributes.get("script:event-name") ?? ""

			if (!/click$/u.test(event)) continue

			if (name === "script:event-listener") {
				return {
					kind: "refused",
					what: "script",
					raw: attributes.get("script:macro-name") ?? attributes.get("xlink:href") ?? "script"
				}
			}

			if (name !== "presentation:event-listener") continue

			const href = attributes.get("xlink:href")

			switch (attributes.get("presentation:action")) {
				case "previous-page":
					return { kind: "internal", jump: "previous" }
				case "next-page":
					return { kind: "internal", jump: "next" }
				case "first-page":
					return { kind: "internal", jump: "first" }
				case "last-page":
					return { kind: "internal", jump: "last" }
				case "stop":
					return { kind: "internal", jump: "end" }
				case "execute":
					return { kind: "refused", what: "execute", raw: href ?? "execute" }
				case "verb":
					return { kind: "refused", what: "ole", raw: attributes.get("presentation:verb") ?? "verb" }
				case "show": {
					if (href === undefined) return undefined
					if (href.startsWith("#")) {
						const slide = context.pageNamed(href.slice(1))

						return slide === undefined ? undefined : { kind: "slide", slide }
					}

					return classifyHref(href)
				}
				default:
					return undefined
			}
		}
	}

	return undefined
}

function altOf(fragment: Fragment, node: number): ShapeNode["alt"] {
	const document = fragment.document
	let title: string | undefined
	let descr: string | undefined

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const name = fragment.name(child)

		if (name === "svg:title") title = document.textContent(child)
		else if (name === "svg:desc") descr = document.textContent(child)
	}

	return title === undefined && descr === undefined ? undefined : { ...(title ? { title } : {}), ...(descr ? { descr } : {}) }
}

function first(fragment: Fragment, node: number, names: ReadonlySet<string>): number[] {
	const out: number[] = []
	const document = fragment.document

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (names.has(fragment.name(child))) out.push(child)

	return out
}

const IMAGE_TYPES = /\.(png|jpe?g|gif|bmp|webp)$/iu

// The picture of a frame: a raster one when the frame offers several (LibreOffice writes an SVG with a PNG beside it).
function pictureOf(fragment: Fragment, images: readonly number[]): string | undefined {
	const parts = images.map(image => packagePart(fragment.attributes(image).get("xlink:href"))).filter(part => part !== undefined)

	return parts.find(part => IMAGE_TYPES.test(part)) ?? parts[0]
}

function tableOf(context: OdpContext, scope: ShapeScope, node: number, box: Box): TableModel {
	const fragment = scope.fragment
	const document = fragment.document
	const attributes = fragment.attributes(node)
	const template = context.template(attributes.get("table:template-name"))
	const flags = {
		firstRow: attributes.get("table:use-first-row-styles") === "true",
		lastRow: attributes.get("table:use-last-row-styles") === "true",
		firstCol: attributes.get("table:use-first-column-styles") === "true",
		lastCol: attributes.get("table:use-last-column-styles") === "true",
		bandRow: attributes.get("table:use-banding-rows-styles") === "true",
		bandCol: attributes.get("table:use-banding-columns-styles") === "true"
	}
	const grid: number[] = []
	// table:default-cell-style-name of each grid column (§19.615), the cell style of cells that name none.
	const columnStyles: (string | undefined)[] = []
	const rows: TableRow[] = []
	const budgets = context.budgets
	let cells = 0

	const column = (child: number): void => {
		const columnAttributes = fragment.attributes(child)
		const repeat = Math.min(budgets.gridColumns, Math.max(1, Number(columnAttributes.get("table:number-columns-repeated") ?? "1") || 1))
		const style = columnAttributes.get("table:style-name")
		const width =
			style === undefined
				? undefined
				: parseLength(
						context.ownProperties("table-column", style, fragment.scope, "table-column").attributes.get("style:column-width")
					)

		const cellStyle = columnAttributes.get("table:default-cell-style-name")

		for (let k = 0; k < repeat; k++) {
			if (grid.length >= budgets.gridColumns) tooLarge("table grid columns", budgets.gridColumns)
			grid.push(Math.round((width ?? 0) * EMU_PER_PT))
			columnStyles.push(cellStyle)
		}
	}

	const row = (child: number, rowIndex: number, rowCount: number): void => {
		const rowAttributes = fragment.attributes(child)
		const style = rowAttributes.get("table:style-name")
		const rowProperties = style === undefined ? NO_PROPERTIES : context.ownProperties("table-row", style, fragment.scope, "table-row")
		const height =
			parseLength(rowProperties.attributes.get("style:row-height")) ??
			parseLength(rowProperties.attributes.get("style:min-row-height")) ??
			0
		const out: TableCell[] = []
		let columnIndex = 0

		for (let cell = document.firstChildElement(child); cell >= 0; cell = document.nextSiblingElement(cell)) {
			const name = fragment.name(cell)

			if (name !== "table:table-cell" && name !== "table:covered-table-cell") continue

			const cellAttributes = fragment.attributes(cell)
			const repeat = Math.min(
				budgets.gridColumns,
				Math.max(1, Number(cellAttributes.get("table:number-columns-repeated") ?? "1") || 1)
			)

			for (let k = 0; k < repeat; k++) {
				if (++cells > budgets.cellsPerTable) tooLarge("table cells", budgets.cellsPerTable)

				const role = template?.(rowIndex, rowCount, columnIndex, grid.length, flags)
				// A cell's own style, else its row's or column's default cell style, over its template role's style.
				const styleName =
					cellAttributes.get("table:style-name") ??
					rowAttributes.get("table:default-cell-style-name") ??
					columnStyles[columnIndex]
				const roleProps = role === undefined ? undefined : cellProps(context, fragment, role)
				const ownProps = styleName === undefined ? undefined : cellProps(context, fragment, styleName)
				const props =
					roleProps === undefined
						? ownProps
						: ownProps === undefined
							? roleProps
							: {
									...roleProps,
									...ownProps,
									...(roleProps.borders === undefined || ownProps.borders === undefined
										? {}
										: { borders: { ...roleProps.borders, ...ownProps.borders } })
								}
				const text =
					name === "table:covered-table-cell"
						? undefined
						: readTextBody(
								context,
								{ ...scope.text, fragment, listStyle: undefined },
								cell,
								// The cell style's paragraph and text properties are its text's defaults.
								styleName === undefined && role === undefined
									? undefined
									: listStyleOf([
											levelStyle(
												overlay(
													role === undefined
														? NO_PROPERTIES
														: context.ownProperties("table-cell", role, fragment.scope, "paragraph"),
													styleName === undefined
														? NO_PROPERTIES
														: context.ownProperties("table-cell", styleName, fragment.scope, "paragraph")
												),
												overlay(
													role === undefined
														? NO_PROPERTIES
														: context.ownProperties("table-cell", role, fragment.scope, "text"),
													styleName === undefined
														? NO_PROPERTIES
														: context.ownProperties("table-cell", styleName, fragment.scope, "text")
												),
												context
											)
										])
							)
				const span = Number(cellAttributes.get("table:number-columns-spanned") ?? "1")
				const rowSpan = Number(cellAttributes.get("table:number-rows-spanned") ?? "1")
				const covered = name === "table:covered-table-cell"

				out.push({
					text: text ?? { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [] }] },
					...(Number.isInteger(span) && span > 1 ? { gridSpan: span } : {}),
					...(Number.isInteger(rowSpan) && rowSpan > 1 ? { rowSpan } : {}),
					...(covered ? { hMerge: true } : {}),
					...(props === undefined ? {} : { props }),
					src: fragment.src(cell)
				})
				columnIndex++
			}
		}

		rows.push({ h: Math.round(height * EMU_PER_PT), cells: out })
	}

	const rowNodes: number[] = []
	const collect = (container: number, depth: number): void => {
		if (depth > 4) return

		for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
			const name = fragment.name(child)

			if (name === "table:table-column") column(child)
			else if (name === "table:table-row") rowNodes.push(child)
			else if (name.startsWith("table:table-") && name !== "table:table-cell") collect(child, depth + 1)
		}
	}

	collect(node, 0)
	rowNodes.forEach((child, index) => row(child, index, rowNodes.length))

	// A covered cell below a row span continues it vertically, not horizontally.
	for (let r = 0; r < rows.length; r++) {
		for (let c = 0; c < (rows[r]?.cells.length ?? 0); c++) {
			const cell = rows[r]?.cells[c]

			if (cell?.rowSpan === undefined) continue

			for (let below = 1; below < cell.rowSpan && r + below < rows.length; below++) {
				const covered = rows[r + below]?.cells[c]

				if (covered?.hMerge === true) {
					delete covered.hMerge
					covered.vMerge = true
				}
			}
		}
	}

	// Columns without a width share what the frame leaves.
	const known = grid.reduce((sum, width) => sum + width, 0)
	const unknown = grid.filter(width => width === 0).length
	const frameWidth = Math.round(box.w * EMU_PER_PT)

	if (unknown > 0) {
		const share = Math.max(0, frameWidth - known) / unknown

		for (let k = 0; k < grid.length; k++) if (grid[k] === 0) grid[k] = Math.round(share)
	}

	if (grid.length === 0) grid.push(frameWidth)

	return { grid, rows, flags, src: fragment.src(node) }
}

function cellProps(context: OdpContext, fragment: Fragment, styleName: string): TableCellProps | undefined {
	// LibreOffice writes a cell's fill and anchor as loext:graphic-properties and its borders in the paragraph
	// properties; ODF's own places are graphic and table-cell properties (§17.18).
	const graphic = overlay(
		context.ownProperties("table-cell", styleName, fragment.scope, "graphic"),
		context.ownProperties("table-cell", styleName, fragment.scope, "loext:graphic")
	)
	const cell = overlay(
		context.ownProperties("table-cell", styleName, fragment.scope, "paragraph"),
		context.ownProperties("table-cell", styleName, fragment.scope, "table-cell")
	)
	const fillFromGraphic = fillOf(graphic, context.sheet.drawResources)
	const background = cell.attributes.get("fo:background-color")
	const fill: FillProps | "none" | undefined =
		fillFromGraphic ??
		(background === undefined
			? undefined
			: background === "transparent"
				? "none"
				: (() => {
						const color = srgb(background)

						return color === undefined ? undefined : { kind: "solid" as const, color }
					})())
	const borders: { [side in "l" | "r" | "t" | "b"]?: LineProps | "none" } = {}

	for (const [side, name] of [
		["l", "left"],
		["r", "right"],
		["t", "top"],
		["b", "bottom"]
	] as const) {
		const value = cell.attributes.get(`fo:border-${name}`)

		if (value === undefined) continue
		if (value === "none" || parseLength(value.trim().split(/\s+/u)[0]) === 0) {
			borders[side] = "none"

			continue
		}

		const width = parseLength(value.split(/\s+/u)[0]) ?? 0.75
		const color = srgb(/#[0-9a-fA-F]{6}/u.exec(value)?.[0])

		borders[side] = { w: Math.round(width * EMU_PER_PT), ...(color === undefined ? {} : { fill: { kind: "solid", color } }) }
	}

	const padding = (side: string): number | undefined => {
		const value = parseLength(cell.attributes.get(`fo:padding-${side}`) ?? graphic.attributes.get(`fo:padding-${side}`))

		return value === undefined ? undefined : Math.round(value * EMU_PER_PT)
	}
	const vertical = cell.attributes.get("style:vertical-align") ?? graphic.attributes.get("draw:textarea-vertical-align")
	const out: { -readonly [K in keyof TableCellProps]: TableCellProps[K] } = {}
	const marL = padding("left")
	const marR = padding("right")
	const marT = padding("top")
	const marB = padding("bottom")

	if (fill !== undefined) out.fill = fill
	if (Object.keys(borders).length > 0) out.borders = borders
	if (marL !== undefined) out.marL = marL
	if (marR !== undefined) out.marR = marR
	if (marT !== undefined) out.marT = marT
	if (marB !== undefined) out.marB = marB
	if (vertical === "middle") out.anchor = "ctr"
	else if (vertical === "bottom") out.anchor = "b"
	else if (vertical === "top") out.anchor = "t"

	return Object.keys(out).length === 0 ? undefined : out
}

function mediaOf(fragment: Fragment, plugin: number, poster: string | undefined): MediaRef {
	const attributes = fragment.attributes(plugin)
	const href = attributes.get("xlink:href") ?? ""
	const part = packagePart(href)
	const mime = attributes.get("draw:mime-type") ?? ""
	const audio = mime.startsWith("audio/") || /\.(mp3|wav|ogg|oga|m4a|aac|flac|wma|aiff?)$/iu.test(href)
	const contentType = mime !== "" && mime !== "application/vnd.sun.star.media" ? mime : audio ? "audio/mpeg" : "video/mp4"

	return {
		kind: audio ? "audio" : "video",
		...(part === undefined ? (href === "" ? {} : { external: href }) : { part }),
		contentType,
		...(poster === undefined ? {} : { poster })
	}
}

const FRAME_CONTENT: ReadonlySet<string> = new Set([
	"draw:text-box",
	"draw:image",
	"draw:object",
	"draw:object-ole",
	"draw:plugin",
	"draw:applet",
	"draw:floating-frame",
	"table:table"
])

// One shape element; undefined for elements that are no shape (event listeners, animations, layers…).
function readShape(context: OdpContext, scope: ShapeScope, node: number, depth: number, link: Action | undefined): ShapeNode | undefined {
	const fragment = scope.fragment
	const name = fragment.name(node)
	const document = fragment.document

	if (depth > MAX_GROUP_DEPTH) tooDeep("shape groups", MAX_GROUP_DEPTH)

	if (name === "draw:a") {
		// A hyperlinked shape: its first shape child, clicked to the link.
		const href = fragment.attributes(node).get("xlink:href")
		const action =
			href === undefined
				? undefined
				: href.startsWith("#")
					? (() => {
							const slide = context.pageNamed(href.slice(1))

							return slide === undefined ? undefined : ({ kind: "slide", slide } as const)
						})()
					: classifyHref(href)

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const shape = readShape(context, scope, child, depth + 1, action)

			if (shape !== undefined) return shape
		}

		return undefined
	}

	if (!name.startsWith("draw:") && name !== "dr3d:scene") return undefined
	if (name === "draw:layer-set" || name === "draw:glue-point" || name === "draw:layer") return undefined

	const attributes = fragment.attributes(node)
	const id = scope.nextId()

	// Every shape a page holds, its groups' members too, against the per-slide budget (ids count them).
	if (id > context.budgets.shapesPerSlide + 1) tooLarge("shapes on a slide", context.budgets.shapesPerSlide)
	const hidden = attributes.get("draw:display") === "none" || attributes.get("draw:display") === "printer"
	const presentationClass = attributes.get("presentation:class")
	const phType = presentationClass === undefined ? undefined : CLASS_TYPES[presentationClass]
	const empty = attributes.get("presentation:placeholder") === "true"
	const style = styleOf(context, fragment, attributes, masterStyleOf(context, scope.masterName, presentationClass))
	const alt = altOf(fragment, node)
	const action = eventAction(context, fragment, node) ?? link
	const locks = protectionOf(style.graphic.attributes.get("style:protect"))
	const base = {
		id,
		name: attributes.get("draw:name") ?? "",
		hidden,
		...(alt === undefined ? {} : { alt }),
		...(locks === undefined ? {} : { locks }),
		...(phType === undefined ? {} : { ph: { type: phType, idx: 0 } }),
		...(action === undefined ? {} : { actions: { click: action } }),
		src: fragment.src(node)
	}
	const box = boxOf(attributes)
	const transform = attributes.get("draw:transform")
	const matrix = transform === undefined ? undefined : transformMatrix(transform)
	const placed = (): Xfrm => {
		const userTransformed = attributes.get("presentation:user-transformed")
		const master = presentationClass === undefined ? undefined : scope.masterBoxes.get(presentationClass)
		const own = attributes.has("svg:x") || attributes.has("svg:width") || matrix !== undefined

		if (master !== undefined && (userTransformed === "false" || !own)) return master

		return xfrmOf(box, matrix)
	}
	const textOf = (container: number, outline: boolean): ShapeNode["text"] => {
		const levels = textLevels(
			context,
			fragment,
			attributes,
			style,
			outline ? masterStyleOf(context, scope.masterName, "outline") : undefined
		)
		const asianSize = asianSizeOf(style.text)
		const body = readTextBody(
			context,
			{ ...scope.text, fragment, listStyle: levels.listStyle, ...(asianSize === undefined ? {} : { asianSize }) },
			container,
			levels.lstStyle
		)

		return body === undefined ? undefined : { ...body, bodyPr: bodyPrOf(style.graphic, style.paragraph) }
	}

	switch (name) {
		case "draw:frame": {
			const contents = first(fragment, node, FRAME_CONTENT)
			const kinds = contents.map(child => fragment.name(child))
			const xfrm = placed()
			const images = contents.filter(child => fragment.name(child) === "draw:image")
			const object = contents.find(child => fragment.name(child) === "draw:object" || fragment.name(child) === "draw:object-ole")
			const plugin = contents.find(child => fragment.name(child) === "draw:plugin")
			const table = contents.find(child => fragment.name(child) === "table:table")
			const textBox = contents.find(child => fragment.name(child) === "draw:text-box")
			const named = pictureOf(fragment, images)
			// A picture the package does not hold (a link, a lost replacement) is none: never fetched (§1.11.2).
			const picture = named !== undefined && context.hasPart(named) ? named : undefined

			if (picture !== undefined) scope.images.add(picture)

			if (table !== undefined) {
				return { ...base, kind: "frame", xfrm, frame: { kind: "table", table: tableOf(context, scope, table, box) } }
			}

			if (plugin !== undefined) {
				const media = mediaOf(fragment, plugin, picture)

				return { ...base, kind: "frame", xfrm, media, frame: { kind: "media", media } }
			}

			if (object !== undefined) {
				const path = packagePart(fragment.attributes(object).get("xlink:href"))
				const chart = path !== undefined && context.isChart(path)

				if (chart && path !== undefined) {
					scope.charts.add(path)

					return {
						...base,
						kind: "frame",
						xfrm,
						frame: { kind: "chart", part: `${path}/chart.xml`, workbook: { part: `${path}/content.xml`, kind: "odfTable" } }
					}
				}

				const frame: FrameRef = {
					kind: "ole",
					progId: context.mediaType(path) ?? "",
					...(path === undefined ? {} : { part: path }),
					...(picture === undefined ? {} : { preview: picture })
				}

				return { ...base, kind: "frame", xfrm, frame }
			}

			if (picture !== undefined && textBox === undefined) {
				const props = graphicProps(context, style, empty, RECT, true)
				const adjust = pictureAdjust(style.graphic.attributes)
				const fill =
					adjust === undefined ? { kind: "picture" as const, part: picture } : { kind: "picture" as const, part: picture, adjust }
				const shape: ShapeNode = { ...base, kind: "pic", xfrm, props: { ...props, fill } }
				const clip = clipOf(style.graphic.attributes.get("fo:clip"))

				if (clip !== undefined) scope.clips.push({ shape, part: picture, clip })

				return shape
			}

			if (textBox !== undefined || kinds.length === 0) {
				const text = textBox === undefined ? undefined : textOf(textBox, presentationClass === "outline")
				const props = graphicProps(context, style, empty, RECT, false)

				return {
					...base,
					kind: "sp",
					xfrm,
					props: { ...props, bodyPr: bodyPrOf(style.graphic, style.paragraph) },
					...(text === undefined ? {} : { text }),
					...(presentationClass === undefined && attributes.get("draw:text-style-name") === undefined
						? { txBox: true as const }
						: {})
				}
			}

			scope.unread++

			return { ...base, kind: "frame", xfrm, frame: { kind: "unknown", src: fragment.src(node) } }
		}
		case "draw:g": {
			const children: ShapeNode[] = []

			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const shape = readShape(context, scope, child, depth + 1, undefined)

				if (shape !== undefined) children.push(shape)
			}

			const bounds = groupBounds(children)

			return { ...base, kind: "grpSp", xfrm: { ...bounds, chX: bounds.x, chY: bounds.y, chCx: bounds.cx, chCy: bounds.cy }, children }
		}
		case "dr3d:scene": {
			scope.unread++

			return { ...base, kind: "frame", xfrm: xfrmOf(box, matrix), frame: { kind: "unknown", src: fragment.src(node) } }
		}
		case "draw:page-thumbnail":
			return {
				...base,
				kind: "sp",
				xfrm: placed(),
				...(phType === undefined ? { ph: { type: "sldImg" as const, idx: 0 } } : {}),
				props: { geometry: RECT }
			}
		default:
			break
	}

	// Drawing shapes: their geometry, then the text they hold.
	let geometry: Geometry = RECT
	let xfrm = xfrmOf(box, matrix)
	let kind: ShapeNode["kind"] = "sp"

	try {
		switch (name) {
			case "draw:custom-shape": {
				const enhanced = first(fragment, node, new Set(["draw:enhanced-geometry"]))[0]

				if (enhanced === undefined) break

				const geometryAttributes = fragment.attributes(enhanced)
				const mirrorX = geometryAttributes.get("draw:mirror-horizontal") === "true"
				const mirrorY = geometryAttributes.get("draw:mirror-vertical") === "true"
				const path = geometryAttributes.get("draw:enhanced-path")

				if (path === undefined || (geometryAttributes.get("draw:text-path") === "true" && path === "")) {
					geometry = { kind: "preset", preset: PRESETS[geometryAttributes.get("draw:type") ?? ""] ?? "rect", guides: [] }
					xfrm = xfrmOf(box, matrix, mirrorX, mirrorY)

					break
				}

				// An absent view box is 0 0 21600 21600 (§19.570); LibreOffice writes "0 0 0 0" for shapes whose formulas
				// work in the shape's own logical size (1/100 mm), as its ooxml-* shapes do.
				const written = geometryAttributes.get("svg:viewBox")
				const viewBox = viewBoxOf(written ?? "0 0 21600 21600", { w: box.w * (2540 / 72), h: box.h * (2540 / 72) })
				const equations = new Map<string, string>()

				for (let child = document.firstChildElement(enhanced); child >= 0; child = document.nextSiblingElement(child)) {
					if (fragment.name(child) !== "draw:equation") continue

					const equation = fragment.attributes(child)
					const equationName = equation.get("draw:name")
					const formula = equation.get("draw:formula")

					if (equationName !== undefined && formula !== undefined) equations.set(equationName, formula)
				}

				const modifiers = (geometryAttributes.get("draw:modifiers") ?? "")
					.trim()
					.split(/\s+/u)
					.filter(item => item !== "")
					.map(item => Number(item) || 0)
				const evaluator = new Evaluator({
					left: viewBox.left,
					top: viewBox.top,
					width: viewBox.width,
					height: viewBox.height,
					logWidth: box.w * (2540 / 72),
					logHeight: box.h * (2540 / 72),
					modifiers,
					equations
				})
				const paths = enhancedPath(path, evaluator)
				const textRect = textAreaOf(geometryAttributes.get("draw:text-areas"), evaluator, viewBox, box)

				geometry = {
					kind: "custom",
					guides: [],
					paths: customPaths(context, paths, viewBox, mirrorX, mirrorY),
					...(textRect === undefined ? {} : { textRect })
				}
				break
			}
			case "draw:rect": {
				const radius = parseLength(attributes.get("draw:corner-radius"))

				if (radius !== undefined && radius > 0) {
					const short = Math.max(Math.min(box.w, box.h), 1e-6)

					geometry = {
						kind: "preset",
						preset: "roundRect",
						guides: [{ name: "adj", formula: `val ${String(Math.round(Math.min(50_000, (radius / short) * 100_000)))}` }]
					}
				}

				break
			}
			case "draw:ellipse":
			case "draw:circle":
				geometry = { kind: "preset", preset: "ellipse", guides: [] }
				break
			case "draw:regular-polygon": {
				const corners = Number(attributes.get("draw:corners") ?? "5")

				geometry = {
					kind: "preset",
					preset:
						attributes.get("draw:concave") === "true"
							? `star${String(Math.min(32, Math.max(4, corners)))}`
							: corners === 3
								? "triangle"
								: corners === 6
									? "hexagon"
									: corners === 8
										? "octagon"
										: "pentagon",
					guides: []
				}
				break
			}
			case "draw:line":
			case "draw:connector":
			case "draw:measure": {
				kind = "cxnSp"

				const d = attributes.get("svg:d")

				if (name === "draw:connector" && d !== undefined && box.w > 0) {
					const viewBox = viewBoxOf(attributes.get("svg:viewBox"), box)

					geometry = {
						kind: "custom",
						guides: [],
						paths: customPaths(
							context,
							svgPath(d).map(path => ({ ...path, fill: false })),
							viewBox,
							false,
							false
						)
					}
					break
				}

				const x1 = parseLength(attributes.get("svg:x1")) ?? 0
				const y1 = parseLength(attributes.get("svg:y1")) ?? 0
				const x2 = parseLength(attributes.get("svg:x2")) ?? 0
				const y2 = parseLength(attributes.get("svg:y2")) ?? 0
				const lineBox = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }

				geometry = { kind: "preset", preset: "line", guides: [] }
				xfrm = xfrmOf(lineBox, matrix, x2 < x1, y2 < y1)
				break
			}
			case "draw:polyline":
			case "draw:polygon":
			case "draw:path": {
				const viewBox = viewBoxOf(attributes.get("svg:viewBox"), box)
				const paths =
					name === "draw:path"
						? svgPath(attributes.get("svg:d") ?? "")
						: pointsPath(attributes.get("draw:points") ?? "", name === "draw:polygon")

				if (name === "draw:polyline") for (const path of paths) path.fill = false

				geometry = { kind: "custom", guides: [], paths: customPaths(context, paths, viewBox, false, false) }
				break
			}
			case "draw:caption":
			case "draw:control":
				break
			default:
				scope.unread++

				return undefined
		}
	} catch (error) {
		if (!(error instanceof GeometryError)) throw error

		geometry = RECT
	}

	const text = name === "draw:control" ? undefined : textOf(node, presentationClass === "outline")
	const props = graphicProps(context, style, empty, geometry, false)

	return {
		...base,
		kind,
		xfrm: phType === undefined ? xfrm : placed(),
		props: { ...props, bodyPr: bodyPrOf(style.graphic, style.paragraph) },
		...(text === undefined ? {} : { text })
	}
}

// A picture's adjustments in its graphic style (draw:luminance §20.123, draw:contrast §20.120, draw:color-mode §20.121,
// draw:image-opacity §20.125) as the model's (edit/ops.ts PictureAdjust); undefined when every one is the default.
// "mono" is a bi-level picture at the middle threshold (LibreOffice draws it so).
function pictureAdjust(attributes: ReadonlyMap<string, string>): PictureAdjust | undefined {
	const percent = (name: string): number | undefined => {
		const match = /^(-?\d+(?:\.\d+)?)%$/u.exec(attributes.get(name)?.trim() ?? "")
		const value = match === null ? undefined : Number(match[1])

		return value === undefined || !Number.isFinite(value) ? undefined : Math.round(Math.max(-100, Math.min(100, value)) * 1000)
	}
	const brightness = percent("draw:luminance")
	const contrast = percent("draw:contrast")
	const opacity = percent("draw:image-opacity")
	const mode = attributes.get("draw:color-mode")
	const adjust: { -readonly [K in keyof PictureAdjust]: PictureAdjust[K] } = {}

	if (brightness !== undefined && brightness !== 0) adjust.brightness = brightness
	if (contrast !== undefined && contrast !== 0) adjust.contrast = contrast
	if (mode === "greyscale") adjust.grayscale = true
	if (mode === "mono") adjust.biLevel = 50_000
	if (opacity !== undefined && opacity < 100_000) adjust.alpha = 100_000 - Math.max(0, opacity)

	return Object.keys(adjust).length === 0 ? undefined : adjust
}

// fo:clip="rect(top, right, bottom, left)" (§20.180) in points; undefined for none, "auto" sides or all zero.
function clipOf(value: string | undefined): [number, number, number, number] | undefined {
	const match = /^\s*rect\s*\(([^)]*)\)\s*$/u.exec(value ?? "")

	if (match === null) return undefined

	const sides = (match[1] ?? "")
		.split(/[\s,]+/u)
		.filter(side => side !== "")
		.map(side => (side === "auto" ? 0 : (parseLength(side) ?? Number.NaN)))

	if (sides.length !== 4 || sides.some(side => !Number.isFinite(side)) || sides.every(side => side === 0)) return undefined

	return [sides[0] ?? 0, sides[1] ?? 0, sides[2] ?? 0, sides[3] ?? 0]
}

// draw:text-areas (§19.147): the first text rectangle, in the shape's EMU box, as a:rect values.
function textAreaOf(
	areas: string | undefined,
	evaluator: Evaluator,
	viewBox: { left: number; top: number; width: number; height: number },
	box: Box
): { l: string; t: string; r: string; b: string } | undefined {
	if (areas === undefined) return undefined

	const parameters = areas.trim().split(/\s+/u).slice(0, 4)

	if (parameters.length < 4) return undefined

	try {
		const [left, top, right, bottom] = parameters.map(parameter => evaluator.value(parameter))
		const x = (value: number | undefined): string =>
			String(Math.round((((value ?? 0) - viewBox.left) / viewBox.width) * box.w * EMU_PER_PT))
		const y = (value: number | undefined): string =>
			String(Math.round((((value ?? 0) - viewBox.top) / viewBox.height) * box.h * EMU_PER_PT))

		return { l: x(left), t: y(top), r: x(right), b: y(bottom) }
	} catch (error) {
		if (error instanceof GeometryError) return undefined

		throw error
	}
}

// A group's box: the bounds of its children as they are drawn (rotated boxes by their corners), which is where
// LibreOffice places a group (its snap rectangle).
function groupBounds(children: readonly ShapeNode[]): Xfrm {
	let left = Infinity
	let top = Infinity
	let right = -Infinity
	let bottom = -Infinity

	for (const child of children) {
		const xfrm = child.xfrm

		if (xfrm === undefined) continue

		const radians = (xfrm.rot / 60_000) * (Math.PI / 180)
		const cos = Math.abs(Math.cos(radians))
		const sin = Math.abs(Math.sin(radians))
		const halfW = (xfrm.cx * cos + xfrm.cy * sin) / 2
		const halfH = (xfrm.cx * sin + xfrm.cy * cos) / 2
		const centerX = xfrm.x + xfrm.cx / 2
		const centerY = xfrm.y + xfrm.cy / 2

		left = Math.min(left, centerX - halfW)
		top = Math.min(top, centerY - halfH)
		right = Math.max(right, centerX + halfW)
		bottom = Math.max(bottom, centerY + halfH)
	}

	if (!Number.isFinite(left)) return { x: 0, y: 0, cx: 0, cy: 0, rot: 0, flipH: false, flipV: false }

	const x = Math.round(left)
	const y = Math.round(top)

	return { x, y, cx: Math.round(right) - x, cy: Math.round(bottom) - y, rot: 0, flipH: false, flipV: false }
}

// The shapes of a page's (or master page's) element, back to front.
export function readShapes(context: OdpContext, scope: ShapeScope, container: number): ShapeNode[] {
	const fragment = scope.fragment
	const document = fragment.document
	const out: ShapeNode[] = []

	for (let child = document.firstChild(container); child >= 0; child = document.nextSibling(child)) {
		if (document.kind(child) !== NodeKind.Element) continue

		const name = fragment.name(child)

		if (
			name === "presentation:notes" ||
			name === "office:forms" ||
			name.startsWith("anim:") ||
			name === "office:annotation" ||
			name === "officeooo:annotation"
		)
			continue

		const shape = readShape(context, scope, child, 0, undefined)

		if (shape === undefined) continue
		out.push(shape)
	}

	return out
}

// Given elements of a fragment as shapes (a master's footer frame read again for one slide).
export function readShapeElements(context: OdpContext, scope: ShapeScope, nodes: readonly number[]): ShapeNode[] {
	const out: ShapeNode[] = []

	for (const node of nodes) {
		const shape = readShape(context, scope, node, 0, undefined)

		if (shape !== undefined) out.push(shape)
	}

	return out
}

// A master page's presentation shapes by class: where placeholders that do not place themselves go.
export function masterBoxesOf(shapes: readonly ShapeNode[], classes: ReadonlyMap<ShapeNode, string>): Map<string, Xfrm> {
	const out = new Map<string, Xfrm>()

	for (const shape of shapes) {
		const name = classes.get(shape)

		if (name !== undefined && shape.xfrm !== undefined && !out.has(name)) out.set(name, shape.xfrm)
	}

	return out
}

export function presentationClassOf(fragment: Fragment, shape: ShapeNode): string | undefined {
	const src = shape.src

	if (src?.format !== "odp" || src.fragment !== fragment.offset) return undefined

	return fragment.attributes(src.node).get("presentation:class")
}
