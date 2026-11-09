import type { DrawingTheme } from "../drawingml/color"
import {
	DrawingList,
	IDENTITY,
	ItemFlag,
	ItemKind,
	boxMatrix,
	multiply,
	rgba,
	type DashPreset,
	type DrawingImage,
	type GradientStops,
	type Inset,
	type Paint,
	type Rgba,
	type Stroke,
	type TextBodyProps,
	type TextVertical
} from "../drawingml/displayList"
import type { ArrowType, LineEnd } from "../drawingml/fill"
import type { GeometryPath } from "../drawingml/geometry/evaluate"
import { MISSING_IMAGE, imageFormat, imageHandling, type ImageResolver } from "../drawingml/picture"
import { D, drawingReader, type DrawingReader } from "../drawingml/reader"
import { addLineEnds } from "../drawingml/shape"
import { plainParagraph } from "../drawingml/text"
import { NodeKind, type XmlDocument } from "../xml/index"
import { parseVmlColor } from "./color"
import { emitVmlPath, ellipseArc, evaluateFormulas, type CoordinateMap, type VmlSegment } from "./path"
import {
	lengthPx,
	parseFractionValue,
	parseLength,
	parseNumbers,
	parsePair,
	parseStyle,
	parseTransform,
	readPlacement,
	type VmlPlacement
} from "./style"

// Legacy VML drawings (w:pict, w:object; ECMA-376 Part 4 §19.1) as the drawing layer's display list.

export interface VmlContext {
	readonly theme?: DrawingTheme
	readonly images: ImageResolver
	// The host's reference for a text box story (w:txbxContent node -> story index).
	readonly story?: (txbxContentNode: number) => number
	// Draw v:shadow (off by default).
	readonly effects?: boolean
}

export interface VmlConversion {
	readonly list: DrawingList
	readonly placement: VmlPlacement
	// w:txbxContent nodes of the text boxes, in drawing order.
	readonly textboxes: number[]
	// Text indices (list.texts) that are WordArt text paths: their text is stretched to fill the box.
	readonly textPaths: number[]
	// Elements left out (groups nested beyond MAX_DEPTH).
	readonly unsupported: number
}

const DRAWABLE: ReadonlySet<string> = new Set(["shape", "rect", "roundrect", "oval", "line", "polyline", "curve", "arc", "image", "group"])
const LINE_LIKE: ReadonlySet<string> = new Set(["line", "polyline", "curve"])

const WHITE = "FFFFFF"
const BLACK = "000000"
const KAPPA = 0.5522847498307936

const shapeTypes = new WeakMap<XmlDocument, Map<string, number>>()

// v:shapetype elements of a part by id, found once per part.
function shapeTypeIndex(reader: DrawingReader): Map<string, number> {
	const document = reader.document
	let index = shapeTypes.get(document)

	if (index === undefined) {
		index = new Map()

		for (let node = 0; node < document.count; node++) {
			if (document.kinds[node] !== NodeKind.Element || document.localName(node) !== "shapetype" || reader.group(node) !== D.V)
				continue

			const id = reader.attr(node, "id")

			if (id !== undefined && !index.has(id)) index.set(id, node)
		}

		shapeTypes.set(document, index)
	}

	return index
}

function isDrawable(reader: DrawingReader, node: number): boolean {
	return reader.group(node) === D.V && DRAWABLE.has(reader.local(node))
}

// The element to draw for a w:pict/w:object (or the node itself when it is drawable): the first drawable
// child, else the first drawable descendant outside text boxes.
function findShape(reader: DrawingReader, node: number): number {
	if (isDrawable(reader, node)) return node

	const document = reader.document

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (isDrawable(reader, child)) return child
	}

	const end = document.end(node)

	for (let n = node + 1; n < document.count && document.start(n) < end; n++) {
		if (document.kinds[n] !== NodeKind.Element) continue

		if (reader.group(n) === D.W && document.localName(n) === "txbxContent") {
			n = skipSubtree(document, n)

			continue
		}

		if (isDrawable(reader, n)) return n
	}

	return -1
}

// The last node inside `node`'s subtree (so the loop's n++ moves past it).
function skipSubtree(document: XmlDocument, node: number): number {
	const end = document.end(node)
	let n = node

	while (n + 1 < document.count && document.start(n + 1) < end) n++

	return n
}

// Attribute and child lookup on a shape with its v:shapetype as the template.
class ShapeProps {
	readonly reader: DrawingReader
	readonly node: number
	readonly type: number

	constructor(reader: DrawingReader, node: number) {
		this.reader = reader
		this.node = node

		const reference = reader.attr(node, "type")

		this.type = reference === undefined ? -1 : (shapeTypeIndex(reader).get(reference.trim().replace(/^#/, "")) ?? -1)
	}

	attr(name: string): string | undefined {
		return this.reader.attr(this.node, name) ?? (this.type < 0 ? undefined : this.reader.attr(this.type, name))
	}

	attrNs(group: D, name: string): string | undefined {
		return this.reader.attrNs(this.node, group, name) ?? (this.type < 0 ? undefined : this.reader.attrNs(this.type, group, name))
	}

	own(local: string): number {
		return this.reader.child(this.node, D.V, local)
	}

	typeChild(local: string): number {
		return this.type < 0 ? -1 : this.reader.child(this.type, D.V, local)
	}

	child(local: string): number {
		const own = this.own(local)

		return own >= 0 ? own : this.typeChild(local)
	}

	// An attribute of child `local`, from the shape's child, else the shapetype's.
	childAttr(local: string, name: string): string | undefined {
		return this.reader.attr(this.own(local), name) ?? this.reader.attr(this.typeChild(local), name)
	}

	childAttrNs(local: string, group: D, name: string): string | undefined {
		return this.reader.attrNs(this.own(local), group, name) ?? this.reader.attrNs(this.typeChild(local), group, name)
	}
}

function isTrue(text: string | undefined, fallback: boolean): boolean {
	if (text === undefined) return fallback

	const value = text.trim().toLowerCase()

	return value === "t" || value === "true" || value === "1" || value === "on"
}

interface Transform {
	readonly rotation: number
	readonly flipH: boolean
	readonly flipV: boolean
}

interface Box {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

interface Parent {
	readonly matrix: readonly number[]
	// Parent coordinates -> parent-local px.
	readonly map: CoordinateMap
	readonly top: boolean
	readonly hidden: boolean
	// The size of a top-level shape's frame.
	readonly frame: Box
}

const DASH_STYLES: Readonly<Record<string, DashPreset>> = {
	solid: "solid",
	shortdash: "sysDash",
	shortdot: "sysDot",
	shortdashdot: "sysDashDot",
	shortdashdotdot: "sysDashDotDot",
	dot: "dot",
	dash: "dash",
	longdash: "lgDash",
	dashdot: "dashDot",
	longdashdot: "lgDashDot",
	longdashdotdot: "lgDashDotDot"
}

const COMPOUNDS: Readonly<Record<string, Stroke["compound"]>> = {
	single: "sng",
	thinthin: "dbl",
	thinthick: "thinThick",
	thickthin: "thickThin",
	thickbetweenthin: "tri"
}

const ARROWS: Readonly<Record<string, ArrowType>> = {
	block: "triangle",
	classic: "stealth",
	oval: "oval",
	diamond: "diamond",
	open: "arrow"
}
const ARROW_WIDTHS: Readonly<Record<string, number>> = { narrow: 2, medium: 3, wide: 5 }
const ARROW_LENGTHS: Readonly<Record<string, number>> = { short: 2, medium: 3, long: 5 }

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value
}

// Group nesting drawn; Office itself nests far less.
export const MAX_DEPTH = 128

class VmlWalker {
	readonly context: VmlContext
	readonly reader: DrawingReader
	readonly list: DrawingList
	readonly textboxes: number[] = []
	readonly textPaths: number[] = []

	constructor(context: VmlContext, reader: DrawingReader, list: DrawingList) {
		this.context = context
		this.reader = reader
		this.list = list
	}

	// Unsupported elements: subtrees cut at MAX_DEPTH.
	unsupported = 0

	// `depth` counts group nesting; past MAX_DEPTH a subtree is skipped, so crafted nesting cannot
	// overflow the stack.
	element(node: number, parent: Parent, depth: number = 0): void {
		if (depth > MAX_DEPTH) {
			this.unsupported++

			return
		}

		const local = this.reader.local(node)
		const style = parseStyle(this.reader.attr(node, "style"))
		const hidden = parent.hidden || style.get("visibility") === "hidden"

		if (local === "group") {
			this.group(node, style, parent, hidden, depth)

			return
		}

		const props = new ShapeProps(this.reader, node)
		const transform = parseTransform(style)

		if (LINE_LIKE.has(local)) {
			this.lineLike(props, local, parent, transform, hidden)

			return
		}

		const box = this.boxOf(style, parent)
		const matrix = multiply(parent.matrix, boxMatrix(box.x, box.y, box.w, box.h, transform.rotation, transform.flipH, transform.flipV))

		this.shape(props, local, style, box, matrix, hidden)
	}

	// A shape's box in parent-local px: the whole frame at the top level, else its style in the parent's
	// coordinates.
	private boxOf(style: ReadonlyMap<string, string>, parent: Parent): Box {
		if (parent.top) return parent.frame

		const map = parent.map
		const coordinate = (name: string): number => parseLength(style.get(name))?.value ?? 0
		const x = coordinate("left") + coordinate("margin-left")
		const y = coordinate("top") + coordinate("margin-top")

		return {
			x: (x - map.originX) * map.scaleX,
			y: (y - map.originY) * map.scaleY,
			w: coordinate("width") * map.scaleX,
			h: coordinate("height") * map.scaleY
		}
	}

	private group(node: number, style: ReadonlyMap<string, string>, parent: Parent, hidden: boolean, depth: number): void {
		const reader = this.reader
		const box = this.boxOf(style, parent)
		const transform = parseTransform(style)
		const [cw, ch] = parseNumbers(reader.attr(node, "coordsize"), [1000, 1000])
		const [ox, oy] = parseNumbers(reader.attr(node, "coordorigin"), [0, 0])
		const matrix = multiply(parent.matrix, boxMatrix(box.x, box.y, box.w, box.h, transform.rotation, transform.flipH, transform.flipV))
		const child: Parent = {
			matrix,
			map: {
				originX: ox ?? 0,
				originY: oy ?? 0,
				scaleX: cw === 0 || cw === undefined ? 1 : box.w / cw,
				scaleY: ch === 0 || ch === undefined ? 1 : box.h / ch
			},
			top: false,
			hidden,
			frame: box
		}
		const document = reader.document

		for (let n = document.firstChildElement(node); n >= 0; n = document.nextSiblingElement(n)) {
			if (isDrawable(reader, n)) this.element(n, child, depth + 1)
		}
	}

	// v:line, v:polyline, v:curve: points in the parent's coordinates.
	private lineLike(props: ShapeProps, local: string, parent: Parent, transform: Transform, hidden: boolean): void {
		const map = parent.map
		const points = linePoints(props, local).map(([x, y]) => [(x - map.originX) * map.scaleX, (y - map.originY) * map.scaleY] as const)

		if (points.length < 2) return

		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity

		for (const [x, y] of points) {
			minX = Math.min(minX, x)
			minY = Math.min(minY, y)
			maxX = Math.max(maxX, x)
			maxY = Math.max(maxY, y)
		}

		const box: Box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
		const matrix = multiply(parent.matrix, boxMatrix(box.x, box.y, box.w, box.h, transform.rotation, transform.flipH, transform.flipV))
		const paint = this.painter(props, box, matrix, hidden)
		const list = this.list
		const firstCommand = list.commandCount
		const firstCoord = list.coordCount
		const at = (index: number): readonly [number, number] => {
			const point = points[index] ?? [0, 0]

			return [point[0] - minX, point[1] - minY]
		}
		const [sx, sy] = at(0)

		list.moveTo(sx, sy)

		if (local === "curve" && points.length === 4) {
			const [x1, y1] = at(1)
			const [x2, y2] = at(2)
			const [x3, y3] = at(3)

			list.cubicTo(x1, y1, x2, y2, x3, y3)
		} else {
			for (let k = 1; k < points.length; k++) {
				const [x, y] = at(k)

				list.lineTo(x, y)
			}
		}

		paint({
			firstCommand,
			firstCoord,
			commandCount: list.commandCount - firstCommand,
			// A polyline is filled only when asked for; lines and curves never are.
			fill: local === "polyline" && props.attr("filled") !== undefined,
			stroke: true,
			open: true
		})
	}

	private shape(
		props: ShapeProps,
		local: string,
		style: ReadonlyMap<string, string>,
		box: Box,
		matrix: readonly number[],
		hidden: boolean
	): void {
		const list = this.list
		const textPathOn = local === "shape" && isTrue(props.childAttr("textpath", "on"), false)
		const imageData = local === "image" ? props.node : props.child("imagedata")
		const picture = imageData >= 0 && this.hasImage(imageData)

		if (picture) this.image(props, imageData, box, matrix, hidden)

		if (!textPathOn) {
			// A picture frame (o:spt 75) paints its image only: its own fill is off unless asked for.
			const fillOff = picture && props.attr("filled") === undefined && props.childAttr("fill", "on") === undefined
			const paint = this.painter(props, box, matrix, hidden, fillOff)
			const firstCommand = list.commandCount
			const firstCoord = list.coordCount
			let open = false

			switch (local) {
				case "rect":
				case "image":
					rectPath(list, box.w, box.h)
					break
				case "roundrect":
					roundRectPath(
						list,
						box.w,
						box.h,
						(clamp01(parseFractionValue(props.attr("arcsize"), 0.2)) * Math.min(box.w, box.h)) / 2
					)
					break
				case "oval":
					ellipsePath(list, box.w, box.h)
					break
				case "arc":
					arcPath(list, box.w, box.h, Number(props.attr("startangle") ?? 0) || 0, Number(props.attr("endangle") ?? 90) || 0)
					open = true
					break
				default:
					this.customPath(props, box, paint)
			}

			if (local !== "shape" && list.commandCount > firstCommand) {
				paint({
					firstCommand,
					firstCoord,
					commandCount: list.commandCount - firstCommand,
					fill: !open || props.attr("filled") !== undefined,
					stroke: true,
					open
				})
			}
		} else {
			this.textPath(props, box, matrix, hidden)
		}

		const textbox = props.own("textbox")

		if (textbox >= 0) this.textbox(props, textbox, style, box, matrix, hidden)
	}

	// v:shape geometry: its path (or the shapetype's) in coordsize/coordorigin units; a rectangle when
	// neither has one (built-in shapetypes the part does not define are not available).
	private customPath(props: ShapeProps, box: Box, paint: (segment: VmlSegment) => void): void {
		const path = props.attr("path") ?? props.childAttr("path", "v")

		if (path === undefined || path.trim() === "") {
			const list = this.list
			const firstCommand = list.commandCount
			const firstCoord = list.coordCount

			rectPath(list, box.w, box.h)
			paint({ firstCommand, firstCoord, commandCount: list.commandCount - firstCommand, fill: true, stroke: true, open: false })

			return
		}

		const { map, formulas, adjust } = this.coordinates(props, box)

		emitVmlPath(this.list, path, map, formulas, adjust, paint)
	}

	private coordinates(props: ShapeProps, box: Box): { map: CoordinateMap; formulas: Float64Array; adjust: number[] } {
		const reader = this.reader
		const [cw = 1000, ch = 1000] = parseNumbers(props.attr("coordsize"), [1000, 1000])
		const [ox = 0, oy = 0] = parseNumbers(props.attr("coordorigin"), [0, 0])
		const typeAdjust = props.type < 0 ? [] : parseNumbers(reader.attr(props.type, "adj"), [])
		const adjust = parseNumbers(reader.attr(props.node, "adj"), typeAdjust)

		for (let k = adjust.length; k < typeAdjust.length; k++) adjust.push(typeAdjust[k] ?? 0)

		const equations = reader.children(props.child("formulas"), D.V, "f").map(f => reader.attr(f, "eqn") ?? "")
		const formulas = evaluateFormulas(equations, {
			width: cw,
			height: ch,
			originX: ox,
			originY: oy,
			pixelWidth: box.w,
			pixelHeight: box.h,
			pixelLineWidth: this.strokeWeight(props),
			lineDrawn: this.stroked(props),
			hasFill: this.filled(props),
			adjust
		})

		return { map: { originX: ox, originY: oy, scaleX: cw === 0 ? 1 : box.w / cw, scaleY: ch === 0 ? 1 : box.h / ch }, formulas, adjust }
	}

	// Resolves the shape's paints once and returns what adds each path segment as an item (with its
	// arrowheads) right after the segment's commands.
	private painter(
		props: ShapeProps,
		box: Box,
		matrix: readonly number[],
		hidden: boolean,
		fillOff: boolean = false
	): (segment: VmlSegment) => void {
		const list = this.list
		const fill = fillOff ? -1 : this.fillPaint(props)
		const line = this.strokeStyle(props)
		const shadow = this.shadow(props)
		const flags = ItemFlag.EVEN_ODD | (hidden ? ItemFlag.HIDDEN : 0)
		const source = props.node

		return segment => {
			const fillIndex = segment.fill ? fill : -1
			const strokeIndex = segment.stroke && line !== undefined ? line.stroke : -1

			if (fillIndex < 0 && strokeIndex < 0) return

			list.addItem(
				ItemKind.PATH,
				matrix,
				0,
				0,
				box.w,
				box.h,
				segment.firstCommand,
				segment.firstCoord,
				fillIndex,
				strokeIndex,
				-1,
				shadow,
				flags,
				source
			)

			if (strokeIndex < 0 || !segment.open || line === undefined || (line.head === undefined && line.tail === undefined)) return

			addLineEnds(list, matrix, line.head, line.tail, geometryPath(segment), strokeIndex, source, fillIndex < 0)
		}
	}

	private filled(props: ShapeProps): boolean {
		return isTrue(props.attr("filled"), true) && isTrue(props.childAttr("fill", "on"), true)
	}

	private stroked(props: ShapeProps): boolean {
		return isTrue(props.attr("stroked"), true) && isTrue(props.childAttr("stroke", "on"), true)
	}

	private strokeWeight(props: ShapeProps): number {
		return lengthPx(props.childAttr("stroke", "weight") ?? props.attr("strokeweight"), 1)
	}

	private fillColor(props: ShapeProps): string {
		return parseVmlColor(props.childAttr("fill", "color") ?? props.attr("fillcolor"), this.context.theme) ?? WHITE
	}

	private opacity(text: string | undefined): number {
		return clamp01(parseFractionValue(text, 1))
	}

	private fillPaint(props: ShapeProps): number {
		if (!this.filled(props)) return -1

		const list = this.list
		const theme = this.context.theme
		const base = this.fillColor(props)
		const opacity = this.opacity(props.childAttr("fill", "opacity"))
		const color = rgba(base, opacity)
		const type = (props.childAttr("fill", "type") ?? "solid").toLowerCase()

		if (type === "gradient" || type === "gradientradial") {
			const color2 = parseVmlColor(props.childAttr("fill", "color2"), theme, base) ?? WHITE
			const opacity2 = this.opacity(
				props.childAttrNs("fill", D.O, "opacity2") ?? props.childAttr("fill", "opacity2") ?? props.childAttr("fill", "opacity")
			)
			const focus = parseFractionValue(props.childAttr("fill", "focus"), 0)
			const stops = gradientStops(props.childAttr("fill", "colors"), base, opacity, color2, opacity2, focus, theme)

			if (type === "gradient") {
				const angle = Number.parseFloat(props.childAttr("fill", "angle") ?? "0") || 0

				return list.paint({ kind: "linear", stops, angle: (((angle - 90) % 360) + 360) % 360, scaled: false })
			}

			const [fx = 0, fy = 0] = parseNumbers(props.childAttr("fill", "focusposition"), [0, 0]).map(value => clamp01(value))
			const [fw = 0, fh = 0] = parseNumbers(props.childAttr("fill", "focussize"), [0, 0]).map(value => clamp01(value))

			return list.paint({
				kind: "path",
				shape: "rect",
				stops,
				focus: { left: fx, top: fy, right: clamp01(1 - fx - fw), bottom: clamp01(1 - fy - fh) }
			})
		}

		if (type === "tile" || type === "frame" || type === "pattern") {
			const id = props.childAttrNs("fill", D.R, "id") ?? props.childAttrNs("fill", D.O, "relid")
			const image = id === undefined ? -1 : this.imageIndex(id, NO_CROP, opacity, false, -1, 0, 0)

			if (image >= 0) {
				const paint: Paint =
					type === "frame"
						? { kind: "image", image, stretch: NO_CROP, tile: undefined }
						: { kind: "image", image, stretch: undefined, tile: { tx: 0, ty: 0, sx: 1, sy: 1, flip: "none", align: "tl" } }

				return list.paint(paint)
			}
		}

		return list.paint({ kind: "solid", color })
	}

	private strokeStyle(props: ShapeProps): { stroke: number; head: LineEnd | undefined; tail: LineEnd | undefined } | undefined {
		if (!this.stroked(props)) return undefined

		const list = this.list
		const color =
			parseVmlColor(props.childAttr("stroke", "color") ?? props.attr("strokecolor"), this.context.theme, this.fillColor(props)) ??
			BLACK
		const paint = list.paint({ kind: "solid", color: rgba(color, this.opacity(props.childAttr("stroke", "opacity"))) })
		const dashText = (props.childAttr("stroke", "dashstyle") ?? "solid").trim()
		const preset = DASH_STYLES[dashText.toLowerCase()]
		let customDash: Float32Array | null = null

		if (preset === undefined) {
			const values = dashText
				.split(/[\s,]+/)
				.map(Number)
				.filter(value => Number.isFinite(value) && value >= 0)

			if (values.length >= 2) customDash = Float32Array.from(values.length % 2 === 0 ? values : [...values, ...values])
		}

		const cap = (props.childAttr("stroke", "endcap") ?? "round").toLowerCase()
		const join = (props.childAttr("stroke", "joinstyle") ?? "round").toLowerCase()
		const stroke: Stroke = {
			width: Math.max(0, this.strokeWeight(props)) || 1,
			paint,
			dash: preset ?? "solid",
			customDash,
			cap: cap === "flat" ? "flat" : cap === "square" ? "square" : "round",
			join: join === "bevel" ? "bevel" : join === "miter" ? "miter" : "round",
			miterLimit: Number.parseFloat(props.childAttr("stroke", "miterlimit") ?? "8") || 8,
			compound: COMPOUNDS[(props.childAttr("stroke", "linestyle") ?? "single").toLowerCase()] ?? "sng",
			inset: false
		}

		return { stroke: list.stroke(stroke), head: arrow(props, "start"), tail: arrow(props, "end") }
	}

	private shadow(props: ShapeProps): number {
		if (this.context.effects !== true) return -1

		const shadow = props.child("shadow")

		if (shadow < 0 || !isTrue(props.childAttr("shadow", "on"), false)) return -1

		const color = parseVmlColor(props.childAttr("shadow", "color"), this.context.theme, this.fillColor(props)) ?? "808080"
		const [dx, dy] = parsePair(props.childAttr("shadow", "offset") ?? "2pt,2pt", [0, 0])

		return this.list.shadow({
			color: rgba(color, this.opacity(props.childAttr("shadow", "opacity"))),
			blur: 0,
			dx: dx.value,
			dy: dy.value,
			sx: 1,
			sy: 1
		})
	}

	private hasImage(imageData: number): boolean {
		const reader = this.reader

		return (
			reader.attrNs(imageData, D.R, "id") !== undefined ||
			reader.attrNs(imageData, D.O, "relid") !== undefined ||
			reader.attr(imageData, "src") !== undefined
		)
	}

	private imageIndex(
		id: string,
		crop: Inset,
		alpha: number,
		grayscale: boolean,
		biLevel: number,
		brightness: number,
		contrast: number
	): number {
		const target = this.context.images(id)
		const extras = { crop, alpha, grayscale, biLevel, brightness, contrast }

		if (target === undefined) return this.list.image({ ...MISSING_IMAGE, ...extras })

		const format = imageFormat(target.partName, target.contentType)
		const image: DrawingImage = {
			partName: target.partName,
			format,
			handling: imageHandling(format),
			svgPartName: undefined,
			duotone: null,
			colorChange: null,
			...extras
		}

		return this.list.image(image)
	}

	private image(props: ShapeProps, imageData: number, box: Box, matrix: readonly number[], hidden: boolean): void {
		const reader = this.reader
		const id = reader.attrNs(imageData, D.R, "id") ?? reader.attrNs(imageData, D.O, "relid") ?? reader.attr(imageData, "src") ?? ""
		const crop: Inset = {
			left: parseFractionValue(reader.attr(imageData, "cropleft"), 0),
			top: parseFractionValue(reader.attr(imageData, "croptop"), 0),
			right: parseFractionValue(reader.attr(imageData, "cropright"), 0),
			bottom: parseFractionValue(reader.attr(imageData, "cropbottom"), 0)
		}
		const gain = parseFractionValue(reader.attr(imageData, "gain"), 1)
		const blackLevel = parseFractionValue(reader.attr(imageData, "blacklevel"), 0)
		// gain scales contrast around the midpoint; blacklevel lifts everything (Word's "washout").
		const contrast = gain <= 0 ? -1 : gain < 1 ? gain - 1 : 1 - 1 / gain
		const index = this.imageIndex(
			id,
			crop,
			1,
			isTrue(reader.attr(imageData, "grayscale"), false),
			isTrue(reader.attr(imageData, "bilevel"), false) ? 0.5 : -1,
			Math.max(-1, Math.min(1, blackLevel)),
			Math.max(-1, Math.min(1, contrast))
		)
		const list = this.list

		list.addItem(
			ItemKind.IMAGE,
			matrix,
			0,
			0,
			box.w,
			box.h,
			list.commandCount,
			list.coordCount,
			-1,
			-1,
			index,
			this.shadow(props),
			hidden ? ItemFlag.HIDDEN : 0,
			props.node
		)
	}

	private textPath(props: ShapeProps, box: Box, matrix: readonly number[], hidden: boolean): void {
		const text = props.childAttr("textpath", "string")

		if (text === undefined || text === "") return

		const style = parseStyle(props.childAttr("textpath", "style"))
		const family = (style.get("font-family") ?? "").replace(/^["']+|["']+$/g, "").trim()
		const weight = (style.get("font-weight") ?? "").toLowerCase()
		const fill = this.filled(props) ? rgba(this.fillColor(props), this.opacity(props.childAttr("fill", "opacity"))) : rgba(BLACK)
		const size = lengthPx(style.get("font-size"), 48 * (96 / 72)) * (72 / 96)
		const paragraph = plainParagraph(
			text,
			{
				size: size > 0 ? size : 36,
				color: fill,
				font: family,
				bold: weight === "bold" || Number.parseInt(weight, 10) >= 600,
				italic: (style.get("font-style") ?? "").toLowerCase() === "italic"
			},
			"ctr"
		)
		const body: TextBodyProps = { ...TEXT_PATH_BODY }
		const list = this.list
		const index = list.text({ kind: "body", body, paragraphs: [paragraph] })

		this.textPaths.push(index)
		list.addItem(
			ItemKind.TEXT,
			matrix,
			0,
			0,
			box.w,
			box.h,
			list.commandCount,
			list.coordCount,
			-1,
			-1,
			index,
			-1,
			hidden ? ItemFlag.HIDDEN : 0,
			props.node
		)
	}

	private textbox(
		props: ShapeProps,
		textbox: number,
		style: ReadonlyMap<string, string>,
		box: Box,
		matrix: readonly number[],
		hidden: boolean
	): void {
		const reader = this.reader
		const content = reader.child(textbox, D.W, "txbxContent")

		if (content < 0) return

		const insets = (reader.attr(textbox, "inset") ?? "").split(",")
		const inset = (index: number, fallback: number): number => {
			const part = insets[index]

			return part === undefined || part.trim() === "" ? fallback : lengthPx(part, fallback)
		}
		const boxStyle = parseStyle(reader.attr(textbox, "style"))
		const flow = (boxStyle.get("layout-flow") ?? "").toLowerCase()
		const flowAlt = (boxStyle.get("mso-layout-flow-alt") ?? "").toLowerCase()
		const vertical: TextVertical =
			flowAlt === "bottom-to-top" ? "vert270" : flow === "vertical" || flow === "vertical-ideographic" ? "vert" : "horz"
		const anchor = (style.get("v-text-anchor") ?? "top").toLowerCase()
		const rect = this.textRect(props, box)
		const body: TextBodyProps = {
			insets: { left: inset(0, 9.6), top: inset(1, 4.8), right: inset(2, 9.6), bottom: inset(3, 4.8) },
			anchor: anchor.startsWith("middle") ? "ctr" : anchor.startsWith("bottom") ? "b" : "t",
			anchorCenter: anchor.includes("center"),
			vertical,
			wrap: style.get("mso-wrap-style") !== "none",
			rotation: 0,
			upright: false,
			columns: 1,
			columnSpacing: 0,
			autofit: isTrue(boxStyle.get("mso-fit-shape-to-text"), false) ? "shape" : "none",
			fontScale: 1,
			lineSpacingReduction: 0
		}
		const list = this.list
		const index = list.text({ kind: "story", body, story: this.context.story?.(content) ?? content })

		this.textboxes.push(content)
		list.addItem(
			ItemKind.TEXT,
			matrix,
			rect.x,
			rect.y,
			rect.w,
			rect.h,
			list.commandCount,
			list.coordCount,
			-1,
			-1,
			index,
			-1,
			hidden ? ItemFlag.HIDDEN : 0,
			props.node
		)
	}

	// The text rectangle: v:path@textboxrect (first rectangle, in coordinates) or the whole box.
	private textRect(props: ShapeProps, box: Box): Box {
		const rect = props.childAttr("path", "textboxrect")

		if (rect === undefined) return { x: 0, y: 0, w: box.w, h: box.h }

		const first = rect.split(";")[0] ?? ""
		const parts = first.split(",")

		if (parts.length !== 4) return { x: 0, y: 0, w: box.w, h: box.h }

		const { map, formulas, adjust } = this.coordinates(props, box)
		const resolve = (token: string | undefined): number => {
			const value = (token ?? "").trim()

			if (value.startsWith("@")) return formulas[Number.parseInt(value.slice(1), 10)] ?? 0
			if (value.startsWith("#")) return adjust[Number.parseInt(value.slice(1), 10)] ?? 0

			return Number(value) || 0
		}
		const left = (resolve(parts[0]) - map.originX) * map.scaleX
		const top = (resolve(parts[1]) - map.originY) * map.scaleY
		const right = (resolve(parts[2]) - map.originX) * map.scaleX
		const bottom = (resolve(parts[3]) - map.originY) * map.scaleY

		return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
	}
}

const NO_CROP: Inset = { left: 0, top: 0, right: 0, bottom: 0 }

const TEXT_PATH_BODY: TextBodyProps = {
	insets: NO_CROP,
	anchor: "ctr",
	anchorCenter: false,
	vertical: "horz",
	wrap: false,
	rotation: 0,
	upright: false,
	columns: 1,
	columnSpacing: 0,
	autofit: "none",
	fontScale: 1,
	lineSpacingReduction: 0
}

function geometryPath(segment: VmlSegment): GeometryPath {
	return {
		firstCommand: segment.firstCommand,
		firstCoord: segment.firstCoord,
		commandCount: segment.commandCount,
		fill: 0,
		stroke: segment.stroke,
		open: segment.open
	}
}

function arrow(props: ShapeProps, end: "start" | "end"): LineEnd | undefined {
	const type = ARROWS[(props.childAttr("stroke", `${end}arrow`) ?? "none").toLowerCase()]

	if (type === undefined) return undefined

	return {
		type,
		width: ARROW_WIDTHS[(props.childAttr("stroke", `${end}arrowwidth`) ?? "medium").toLowerCase()] ?? 3,
		length: ARROW_LENGTHS[(props.childAttr("stroke", `${end}arrowlength`) ?? "medium").toLowerCase()] ?? 3
	}
}

// Points of a line-like element in its parent's coordinates.
function linePoints(props: ShapeProps, local: string): (readonly [number, number])[] {
	const pair = (name: string, fallback: readonly [number, number]): readonly [number, number] => {
		const [x, y] = parsePair(props.attr(name), fallback)

		return [x.value, y.value]
	}

	if (local === "line") return [pair("from", [0, 0]), pair("to", [10, 10])]
	if (local === "curve") return [pair("from", [0, 0]), pair("control1", [10, 10]), pair("control2", [20, 0]), pair("to", [30, 10])]

	const values = (props.attr("points") ?? "")
		.split(/[\s,]+/)
		.filter(part => part !== "")
		.map(part => parseLength(part)?.value ?? 0)
	const out: (readonly [number, number])[] = []

	for (let k = 0; k + 1 < values.length; k += 2) out.push([values[k] ?? 0, values[k + 1] ?? 0])

	return out
}

// Gradient stops for a VML gradient: `colors` (or color -> color2) placed around the focus. The fill
// colour sits at the focus (a fraction of the gradient's length), color2 at the far end(s); a negative
// focus swaps the two.
function gradientStops(
	colors: string | undefined,
	color: string,
	opacity: number,
	color2: string,
	opacity2: number,
	focus: number,
	theme: DrawingTheme | undefined
): GradientStops {
	const base: [number, string][] = []

	for (const entry of (colors ?? "").split(";")) {
		const trimmed = entry.trim()
		const space = trimmed.indexOf(" ")

		if (space <= 0) continue

		const hex = parseVmlColor(trimmed.slice(space + 1), theme)

		if (hex !== undefined) base.push([clamp01(parseFractionValue(trimmed.slice(0, space), 0)), hex])
	}

	if (base.length < 2) {
		base.length = 0
		base.push([0, color], [1, color2])
	}

	base.sort((a, b) => a[0] - b[0])

	const stops: [number, Rgba][] = []
	const swap = focus < 0
	const p = clamp01(Math.abs(focus))
	const at = (t: number, hex: string): Rgba => rgba(hex, opacity + (opacity2 - opacity) * t)

	for (const [t0, hex] of base) {
		const t = swap ? 1 - t0 : t0

		if (p <= 0) stops.push([t, at(t0, hex)])
		else if (p >= 1) stops.push([1 - t, at(t0, hex)])
		else {
			stops.push([p * (1 - t), at(t0, hex)])
			stops.push([p + (1 - p) * t, at(t0, hex)])
		}
	}

	stops.sort((a, b) => a[0] - b[0])

	return { offsets: Float32Array.from(stops, stop => stop[0]), colors: Uint32Array.from(stops, stop => stop[1]) }
}

function rectPath(list: DrawingList, w: number, h: number): void {
	list.moveTo(0, 0)
	list.lineTo(w, 0)
	list.lineTo(w, h)
	list.lineTo(0, h)
	list.close()
}

function roundRectPath(list: DrawingList, w: number, h: number, r: number): void {
	if (r <= 0) {
		rectPath(list, w, h)

		return
	}

	const k = r * (1 - KAPPA)

	list.moveTo(r, 0)
	list.lineTo(w - r, 0)
	list.cubicTo(w - k, 0, w, k, w, r)
	list.lineTo(w, h - r)
	list.cubicTo(w, h - k, w - k, h, w - r, h)
	list.lineTo(r, h)
	list.cubicTo(k, h, 0, h - k, 0, h - r)
	list.lineTo(0, r)
	list.cubicTo(0, k, k, 0, r, 0)
	list.close()
}

function ellipsePath(list: DrawingList, w: number, h: number): void {
	list.moveTo(w, h / 2)
	ellipseArc(list, w / 2, h / 2, w / 2, h / 2, 0, 2 * Math.PI)
	list.close()
}

// v:arc: angles in degrees clockwise from 12 o'clock on the ellipse inscribed in the box.
function arcPath(list: DrawingList, w: number, h: number, startAngle: number, endAngle: number): void {
	const rx = w / 2
	const ry = h / 2
	const parametric = (degrees: number): number => {
		const radians = (degrees * Math.PI) / 180

		return Math.atan2(-Math.cos(radians) * rx, Math.sin(radians) * ry)
	}
	const t0 = parametric(startAngle)
	let delta = parametric(endAngle) - t0
	const sweep = endAngle - startAngle

	if (Math.abs(sweep) >= 360) delta = Math.sign(sweep) * 2 * Math.PI
	else if (sweep > 0 && delta <= 0) delta += 2 * Math.PI
	else if (sweep < 0 && delta >= 0) delta -= 2 * Math.PI

	list.moveTo(rx + rx * Math.cos(t0), ry + ry * Math.sin(t0))
	ellipseArc(list, rx, ry, rx, ry, t0, delta)
}

// The w10:wrap of a top-level shape and o:allowincell.
function wrapOf(reader: DrawingReader, node: number): { type: string | undefined; side: string | undefined } | undefined {
	const wrap = reader.child(node, D.W10, "wrap")

	return wrap < 0 ? undefined : { type: reader.attr(wrap, "type"), side: reader.attr(wrap, "side") }
}

// Converts a VML drawing: a w:pict or w:object (its first drawable v:* element) or a v:* element itself.
// Undefined when there is nothing drawable. The list's frame is the shape's box (px), rotation and flips
// included in its matrices; `placement` says where the frame goes.
export function convertVml(context: VmlContext, document: XmlDocument, node: number): VmlConversion | undefined {
	const reader = drawingReader(document)
	const shape = findShape(reader, node)

	if (shape < 0) return undefined

	const local = reader.local(shape)
	const style = parseStyle(reader.attr(shape, "style"))
	const props = new ShapeProps(reader, shape)
	let width = lengthPx(style.get("width"), 0)
	let height = lengthPx(style.get("height"), 0)
	let originX = 0
	let originY = 0

	if (LINE_LIKE.has(local)) {
		const points = linePoints(props, local)

		if (points.length > 0) {
			// A loop, not Math.min(...points): a long polyline would overflow the argument stack.
			let maxX = -Infinity
			let maxY = -Infinity

			originX = Infinity
			originY = Infinity

			for (const [x, y] of points) {
				if (x < originX) originX = x
				if (y < originY) originY = y
				if (x > maxX) maxX = x
				if (y > maxY) maxY = y
			}

			width = maxX - originX
			height = maxY - originY
		}
	}

	const allowInCell = isTrue(reader.attrNs(shape, D.O, "allowincell"), true)
	const base = readPlacement(style, wrapOf(reader, shape), allowInCell, { width, height })
	const placement: VmlPlacement = LINE_LIKE.has(local)
		? { ...base, marginLeft: base.marginLeft + originX, marginTop: base.marginTop + originY }
		: base
	const list = new DrawingList()

	list.width = width
	list.height = height

	const walker = new VmlWalker(context, reader, list)

	walker.element(shape, {
		matrix: IDENTITY,
		map: { originX, originY, scaleX: 1, scaleY: 1 },
		top: true,
		hidden: false,
		frame: { x: 0, y: 0, w: width, h: height }
	})

	return { list, placement, textboxes: walker.textboxes, textPaths: walker.textPaths, unsupported: walker.unsupported }
}
