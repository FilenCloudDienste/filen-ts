import { maxOf, minOf } from "../arrays"
import { parseLength, parsePercent, type OdfProperties } from "../odf/index"
import { customGeometry, enhancedPath, Evaluator, GeometryError, pointsPath, svgPath, type SubPath } from "./geometry"
import type { Translator } from "./translator"
import { presetOfOdfType } from "../odf/presetShapes"
import { decompose, transformMatrix } from "../odf/transform"
import { emu, esc } from "./wml"

// Frames and shapes (Part 3 §10) as DrawingML in w:drawing: images as pictures, text boxes and shapes as
// WordprocessingML shapes (wps:wsp) with their text in w:txbxContent, custom geometry evaluated to custGeom.
// Charts, formulas and other embedded objects show their replacement image, or a placeholder box.

// With optimal wrapping (style:wrap="dynamic"), LibreOffice flows text beside a frame only into a gap at least
// this wide (2 cm; measured over UNO: 1.99 cm stays empty, 2.01 cm takes text). Parallel wrapping fills any gap.
export const MIN_WRAP_WIDTH = (2 / 2.54) * 72

export interface MediaReference {
	// Path inside the ODF package, and the part it is linked as.
	readonly source: string
	readonly part: string
}

interface Placement {
	readonly anchorType: string
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	readonly autoHeight: boolean
	readonly graphic: OdfProperties
	readonly name: string
	readonly description: string
	readonly zIndex: number
	// Clockwise degrees about the centre, in [0, 360); flipV: mirrored by draw:transform (flipped before the turn).
	readonly rotation: number
	readonly flipV: boolean
	// How far the drawn outline reaches past the extent (half a stroke), for wrapping.
	readonly reach?: number
}

function colorOf(value: string | undefined): string | undefined {
	return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value) ? value.slice(1).toUpperCase() : undefined
}

// The first bytes of a stream say what it is: what the viewer draws, or why not.
export function imageKind(head: Uint8Array): "png" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "wmf" | "emf" | "tiff" | "svm" | "unknown" {
	const b = (k: number): number => head[k] ?? -1

	if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "png"
	if (b(0) === 0xff && b(1) === 0xd8) return "jpeg"
	if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return "gif"
	if (b(0) === 0x42 && b(1) === 0x4d) return "bmp"
	if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45) return "webp"
	if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2a) || (b(0) === 0x4d && b(1) === 0x4d && b(3) === 0x2a)) return "tiff"
	if (b(0) === 0xd7 && b(1) === 0xcd && b(2) === 0xc6 && b(3) === 0x9a) return "wmf"
	if ((b(0) === 1 || b(0) === 2) && b(1) === 0 && b(2) === 9 && b(3) === 0) return "wmf"
	if (b(0) === 1 && b(1) === 0 && b(2) === 0 && b(3) === 0 && b(40) === 0x20 && b(41) === 0x45 && b(42) === 0x4d && b(43) === 0x46)
		return "emf"
	if (b(0) === 0x56 && b(1) === 0x43 && b(2) === 0x4c && b(3) === 0x4d && b(4) === 0x54 && b(5) === 0x46) return "svm"

	const text = String.fromCharCode(...head.subarray(0, Math.min(head.length, 256)))

	if (/<svg[\s>]/i.test(text)) return "svg"

	return "unknown"
}

const EXTENSIONS: Readonly<Record<string, string>> = {
	png: "png",
	jpeg: "jpeg",
	gif: "gif",
	bmp: "bmp",
	webp: "webp",
	svg: "svg",
	wmf: "wmf",
	emf: "emf",
	tiff: "tiff"
}

export class Frames {
	private readonly translator: Translator
	// Package streams' kinds, sniffed before translating (see translate.ts).
	readonly kinds = new Map<string, ReturnType<typeof imageKind>>()
	readonly media: MediaReference[] = []
	private readonly mediaParts = new Map<string, string>()
	// While an as-char group is translated: its members' placements and graphics, for one group drawing.
	private members: { readonly placement: Placement; readonly graphic: string }[] | undefined

	constructor(translator: Translator) {
		this.translator = translator
	}

	// A frame or shape as runs. `context`: where it was found ("page": a direct child of office:text).
	translate(node: number, context: "paragraph" | "page"): string {
		const translator = this.translator
		const name = translator.name(node)

		try {
			switch (name) {
				case "draw:frame":
					return this.frame(node, context)
				case "draw:g":
				case "draw:a": {
					if (name === "draw:g" && this.members === undefined) {
						if (translator.attributes(node).get("text:anchor-type") === "as-char") return this.group(node)

						translator.lossy("shapeApproximated")
					}

					let out = ""

					translator.enter()

					for (
						let child = translator.document.firstChildElement(node);
						child >= 0;
						child = translator.document.nextSiblingElement(child)
					) {
						out += this.translate(child, context)
					}

					translator.leave()

					return out
				}
				default:
					if (name.startsWith("draw:") || name.startsWith("dr3d:")) return this.shape(node, name, context)

					return ""
			}
		} catch (error) {
			if (!(error instanceof GeometryError)) throw error

			translator.lossy("shapeApproximated")

			return ""
		}
	}

	// `contentMinHeight`: a text box's fo:min-height, which an auto-height frame grows to.
	private placement(node: number, attributes: Map<string, string>, context: "paragraph" | "page", contentMinHeight?: number): Placement {
		const translator = this.translator
		const graphic = translator.resolver.resolve("graphic", attributes.get("draw:style-name"), translator.scope).properties("graphic")
		const anchorType = attributes.get("text:anchor-type") ?? (context === "page" ? "page" : "paragraph")
		const height = parseLength(attributes.get("svg:height"))
		const minHeight = parseLength(attributes.get("fo:min-height"))
		const transform = attributes.get("draw:transform")
		let x = parseLength(attributes.get("svg:x")) ?? 0
		let y = parseLength(attributes.get("svg:y")) ?? 0
		let width = Math.max(0, parseLength(attributes.get("svg:width")) ?? parseLength(attributes.get("fo:min-width")) ?? 0)
		let boxHeight = height === undefined ? Math.max(0, minHeight ?? 0, contentMinHeight ?? 0) : Math.max(0, height)
		let rotation = 0
		let flipV = false
		const matrix = transform === undefined ? undefined : transformMatrix(transform)

		// The box under draw:transform as DrawingML's unrotated box turned about its centre (posOffset places the
		// unrotated extent).
		if (matrix !== undefined) {
			const parts = decompose({ x, y, w: width, h: boxHeight }, matrix)

			if (
				Number.isFinite(parts.x) &&
				Number.isFinite(parts.y) &&
				Number.isFinite(parts.w) &&
				Number.isFinite(parts.h) &&
				Number.isFinite(parts.degrees)
			) {
				if (!parts.exact) translator.lossy("shapeApproximated")

				x = parts.x
				y = parts.y
				width = parts.w
				boxHeight = parts.h
				rotation = parts.degrees
				flipV = parts.mirrored
			} else {
				translator.lossy("shapeApproximated")
			}
		}

		if (anchorType === "frame") translator.lossy("frameAnchor")
		// Kept on its anchor's page (the translation's flow-with-text setting), not inside the page's text area.
		if (anchorType !== "as-char" && anchorType !== "page" && graphic.attributes.get("style:flow-with-text") === "true")
			translator.lossy("frameAnchor")
		if (anchorType === "page" && Number(attributes.get("text:anchor-page-number") ?? "1") > 1) translator.lossy("frameAnchor")

		let description = ""

		for (let child = translator.document.firstChildElement(node); child >= 0; child = translator.document.nextSiblingElement(child)) {
			const childName = translator.name(child)

			if (childName === "svg:title" || childName === "svg:desc")
				description = description === "" ? translator.document.textContent(child) : description
		}

		return {
			anchorType,
			x,
			y,
			width,
			height: boxHeight,
			autoHeight: height === undefined,
			graphic,
			name: attributes.get("draw:name") ?? "",
			description,
			zIndex: Number(attributes.get("draw:z-index") ?? "0") || 0,
			rotation,
			flipV
		}
	}

	// An as-char group (Part 3 §10.3.15 draw:g) as one character: an inline WordprocessingML group (wpg:wgp) of its
	// members, as large as their bounds; a nested group's members join it.
	private group(node: number): string {
		const translator = this.translator
		const members: { readonly placement: Placement; readonly graphic: string }[] = []

		this.members = members
		translator.enter()

		try {
			for (
				let child = translator.document.firstChildElement(node);
				child >= 0;
				child = translator.document.nextSiblingElement(child)
			) {
				this.translate(child, "paragraph")
			}
		} finally {
			translator.leave()
			this.members = undefined
		}

		if (members.length === 0) return ""

		const left = minOf(members.map(member => member.placement.x))
		const top = minOf(members.map(member => member.placement.y))
		const right = maxOf(members.map(member => member.placement.x + member.placement.width))
		const bottom = maxOf(members.map(member => member.placement.y + member.placement.height))
		const x = emu(left)
		const y = emu(top)
		const cx = Math.max(0, emu(right - left))
		const cy = Math.max(0, emu(bottom - top))
		const children = members.map(member => groupMember(member.graphic, emu(member.placement.x), emu(member.placement.y))).join("")
		const attributes = translator.attributes(node)
		const placement = {
			...this.placement(node, attributes, "paragraph"),
			x: left,
			y: top,
			width: right - left,
			height: bottom - top
		}

		return this.drawing(
			placement,
			`<a:graphic><a:graphicData uri="${WPG}"><wpg:wgp xmlns:wpg="${WPG}"><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></wpg:grpSpPr>${children}</wpg:wgp></a:graphicData></a:graphic>`
		)
	}

	// The w:drawing for a graphic in its placement, as a run (in a group, a member of it).
	private drawing(placement: Placement, graphic: string): string {
		if (this.members !== undefined) {
			this.members.push({ placement, graphic })

			return ""
		}

		const translator = this.translator
		const id = translator.id()
		const cx = emu(placement.width)
		const cy = emu(placement.height)
		const docPr = `<wp:docPr id="${id}" name="${esc(placement.name || `Frame ${id}`)}"${placement.description === "" ? "" : ` descr="${esc(placement.description)}"`}/>`
		const properties = placement.graphic.attributes
		const margin = (side: string): number =>
			Math.max(0, emu((parseLength(properties.get(`fo:margin-${side}`)) ?? 0) + (placement.reach ?? 0)))

		if (placement.anchorType === "as-char") {
			return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>${docPr}${graphic}</wp:inline></w:drawing></w:r>`
		}

		const wrapMode = properties.get("style:wrap") ?? "none"
		const background = properties.get("style:run-through") === "background"
		const horizontal = this.horizontal(placement)
		const vertical = this.vertical(placement)
		const wrap = this.wrap(placement, wrapMode)

		return `<w:r><w:drawing><wp:anchor distT="${margin("top")}" distB="${margin("bottom")}" distL="${margin("left")}" distR="${margin("right")}" simplePos="0" relativeHeight="${Math.max(0, placement.zIndex) + 2}" behindDoc="${wrapMode === "run-through" && background ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>${horizontal}${vertical}<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}${docPr}${graphic}</wp:anchor></w:drawing></w:r>`
	}

	private horizontal(placement: Placement): string {
		const properties = placement.graphic.attributes
		const relation = properties.get("style:horizontal-rel") ?? (placement.anchorType === "page" ? "page" : "paragraph")
		const position = properties.get("style:horizontal-pos") ?? "from-left"
		const from =
			relation === "page"
				? "page"
				: relation === "page-content" || relation === "page-start-margin"
					? relation === "page-start-margin"
						? "leftMargin"
						: "margin"
					: relation === "page-end-margin"
						? "rightMargin"
						: relation === "char"
							? "character"
							: "column"
		const align =
			position === "left" || position === "right" || position === "center"
				? position
				: position === "inside" || position === "outside"
					? position
					: undefined

		return `<wp:positionH relativeFrom="${from}">${align === undefined ? `<wp:posOffset>${emu(placement.x)}</wp:posOffset>` : `<wp:align>${align}</wp:align>`}</wp:positionH>`
	}

	private vertical(placement: Placement): string {
		const properties = placement.graphic.attributes
		const relation = properties.get("style:vertical-rel") ?? (placement.anchorType === "page" ? "page" : "paragraph")
		const position = properties.get("style:vertical-pos") ?? "from-top"
		const from =
			relation === "page"
				? "page"
				: relation === "page-content"
					? "margin"
					: relation === "char" || relation === "line" || relation === "baseline" || relation === "text"
						? "line"
						: "paragraph"
		const align = position === "top" ? "top" : position === "middle" ? "center" : position === "bottom" ? "bottom" : undefined

		return `<wp:positionV relativeFrom="${from}">${align === undefined ? `<wp:posOffset>${emu(placement.y)}</wp:posOffset>` : `<wp:align>${align}</wp:align>`}</wp:positionV>`
	}

	// The wrap element. Optimal wrapping ("dynamic", and "biggest") uses only the wider side, and only when it
	// is at least MIN_WRAP_WIDTH wide.
	private wrap(placement: Placement, mode: string): string {
		if (mode === "none") return "<wp:wrapTopAndBottom/>"
		if (mode === "run-through") return "<wp:wrapNone/>"

		const optimal = mode === "dynamic" || mode === "biggest"
		let left = mode === "parallel" || optimal || mode === "left"
		let right = mode === "parallel" || optimal || mode === "right"
		const gaps = optimal ? this.gaps(placement) : undefined

		if (gaps !== undefined) {
			if (gaps.left >= gaps.right) right = false
			else left = false

			if (Math.max(gaps.left, gaps.right) < MIN_WRAP_WIDTH - 1e-6) left = right = false
		}

		if (!left && !right) return "<wp:wrapTopAndBottom/>"

		const side = left && right ? "bothSides" : left ? "left" : "right"
		const tag = placement.graphic.attributes.get("style:wrap-contour") === "true" ? "wrapTight" : "wrapSquare"

		return tag === "wrapTight"
			? `<wp:wrapTight wrapText="${side}"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>`
			: `<wp:wrapSquare wrapText="${side}"/>`
	}

	// Room left and right of the frame in the column, when its horizontal position is known statically.
	private gaps(placement: Placement): { readonly left: number; readonly right: number } | undefined {
		const properties = placement.graphic.attributes
		const relation = properties.get("style:horizontal-rel") ?? (placement.anchorType === "page" ? "page" : "paragraph")
		const position = properties.get("style:horizontal-pos") ?? "from-left"
		const width = this.translator.width
		const margins = (parseLength(properties.get("fo:margin-left")) ?? 0) + (parseLength(properties.get("fo:margin-right")) ?? 0)
		let left: number

		if (relation !== "paragraph" && relation !== "paragraph-content" && relation !== "page-content" && relation !== "page")
			return undefined

		switch (position) {
			case "left":
				left = 0
				break
			case "right":
				left = width - placement.width
				break
			case "center":
				left = (width - placement.width) / 2
				break
			case "from-left":
				left = relation === "page" ? placement.x - this.translator.pages.marginLeft : placement.x
				break
			default:
				return undefined
		}

		return {
			left: left - (parseLength(properties.get("fo:margin-left")) ?? 0),
			right: width - left - placement.width - (margins - (parseLength(properties.get("fo:margin-left")) ?? 0))
		}
	}

	private frame(node: number, context: "paragraph" | "page"): string {
		const translator = this.translator
		const document = translator.document
		const attributes = translator.attributes(node)
		let textBox = -1
		let image: string | undefined
		let object: string | undefined
		let unsupported = false

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const name = translator.name(child)
			const href = translator.attributes(child).get("xlink:href")

			if (name === "draw:text-box" && textBox < 0) {
				textBox = child
			} else if (name === "draw:image" && image === undefined) {
				const path = href === undefined ? undefined : packagePath(href)
				const kind = path === undefined ? undefined : this.kinds.get(path)

				if (path !== undefined && kind !== undefined && kind !== "svm" && kind !== "unknown") image = path
				else unsupported = true
			} else if (
				(name === "draw:object" || name === "draw:object-ole" || name === "draw:plugin" || name === "draw:applet") &&
				object === undefined
			) {
				object = href === undefined ? name : objectKind(translator, href, name)
			}
		}

		if (object !== undefined) {
			translator.lossy("embeddedObject")
			translator.objectKinds.set(object, (translator.objectKinds.get(object) ?? 0) + 1)
		}

		const boxAttributes = textBox >= 0 ? translator.attributes(textBox) : undefined
		// Before the transform places it: a taller box turns about another centre.
		const placement = this.placement(node, attributes, context, parseLength(boxAttributes?.get("fo:min-height")))

		if (boxAttributes !== undefined) {
			if (boxAttributes.has("draw:chain-next-name")) translator.lossy("chainedTextBox")

			return this.drawing(placement, this.shapeGraphic(placement, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', textBox, true))
		}

		if (image !== undefined) return this.drawing(placement, this.picture(placement, image))

		if (unsupported) translator.lossy(object === undefined ? "unsupportedImage" : "embeddedObject")

		// A placeholder: a box the size of the frame.
		return this.drawing(
			placement,
			this.shapeGraphic(placement, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', -1, false, "placeholder")
		)
	}

	// The word/-relative media part a package picture is linked as, one per source; undefined when it is not a
	// picture the translation carries (unknown, SVM, or not in the package).
	mediaPart(href: string): string | undefined {
		const source = packagePath(href)
		const kind = source === undefined ? undefined : this.kinds.get(source)

		return source === undefined || kind === undefined || kind === "svm" || kind === "unknown" ? undefined : this.partOf(source)
	}

	private partOf(source: string): string {
		let part = this.mediaParts.get(source)

		if (part === undefined) {
			const kind = this.kinds.get(source) ?? "png"

			part = `media/image${this.mediaParts.size + 1}.${EXTENSIONS[kind] ?? "png"}`
			this.mediaParts.set(source, part)
			this.media.push({ source, part: `word/${part}` })
		}

		return part
	}

	private picture(placement: Placement, source: string): string {
		const translator = this.translator
		const properties = placement.graphic.attributes
		const part = this.partOf(source)
		const rId = translator.relationship("image", part, false)
		const mirror = properties.get("style:mirror") ?? "none"
		const flipH = mirror.includes("horizontal") ? ' flipH="1"' : ""
		const flipV = mirror.includes("vertical") !== placement.flipV ? ' flipV="1"' : ""
		const rot = rotationOf(placement)

		if (
			cropped(properties.get("fo:clip")) ||
			ADJUSTMENTS.some(name => (parsePercent(properties.get(name)) ?? 0) !== 0) ||
			(parsePercent(properties.get("draw:gamma")) ?? 100) !== 100 ||
			(properties.get("draw:color-mode") ?? "standard") !== "standard"
		) {
			translator.lossy("imageAdjustment")
		}

		// draw:image-opacity (ODF 1.3 Part 3) is DrawingML's alpha modulation (a:alphaModFix, ECMA-376 Part 1
		// §20.1.8.6), in thousandths of a percent.
		const opacity = parsePercent(properties.get("draw:image-opacity"))
		const alpha = opacity !== undefined && opacity >= 0 && opacity < 100 ? `<a:alphaModFix amt="${Math.round(opacity * 1000)}"/>` : ""

		const id = translator.id()

		return `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(placement.name || `Image ${id}`)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"${alpha === "" ? "/>" : `>${alpha}</a:blip>`}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm${rot}${flipH}${flipV}><a:off x="0" y="0"/><a:ext cx="${emu(placement.width)}" cy="${emu(placement.height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${this.line(placement.graphic)}</pic:spPr></pic:pic></a:graphicData></a:graphic>`
	}

	// A wps:wsp: geometry, fill and line from the graphic style, text from `textNode`'s blocks.
	// `look`: "placeholder" draws a grey box (an object not shown), "text" no outline or fill (Fontwork's text).
	private shapeGraphic(
		placement: Placement,
		geometry: string,
		textNode: number,
		frame: boolean,
		look: "placeholder" | "text" | "own" = "own",
		flips?: { readonly h: boolean; readonly v: boolean }
	): string {
		const translator = this.translator
		const properties = placement.graphic.attributes
		const id = translator.id()
		const transform =
			rotationOf(placement) + (flips?.h === true ? ' flipH="1"' : "") + ((flips?.v === true) !== placement.flipV ? ' flipV="1"' : "")
		const fill =
			look === "placeholder"
				? '<a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill>'
				: look === "text"
					? "<a:noFill/>"
					: this.fill(properties, frame)
		const line =
			look === "placeholder"
				? '<a:ln w="6350"><a:solidFill><a:srgbClr val="A6A6A6"/></a:solidFill></a:ln>'
				: look === "text"
					? "<a:ln><a:noFill/></a:ln>"
					: frame
						? this.frameLine(placement.graphic)
						: this.line(placement.graphic)
		const padding = (side: string): number => emu(parseLength(properties.get(`fo:padding-${side}`)) ?? 0)
		let text = ""
		const body = `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="${padding("left")}" tIns="${padding("top")}" rIns="${padding("right")}" bIns="${padding("bottom")}" anchor="${this.textAnchor(properties)}" anchorCtr="0">${placement.autoHeight && frame ? "<a:spAutoFit/>" : "<a:noAutofit/>"}</wps:bodyPr>`

		if (textNode >= 0) {
			const inner = Math.max(
				1,
				placement.width -
					(parseLength(properties.get("fo:padding-left")) ?? 0) -
					(parseLength(properties.get("fo:padding-right")) ?? 0)
			)
			// Drawings in a group member's text are that text's, not the group's.
			const members = this.members

			this.members = undefined

			let markup: string

			try {
				markup = translator.story(textNode, inner, properties.get("style:writing-mode"))
			} finally {
				this.members = members
			}

			text = `<wps:txbx><w:txbxContent>${markup}</w:txbxContent></wps:txbx>`
		}

		return `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvPr id="${id}" name="${esc(placement.name || `Shape ${id}`)}"/><wps:cNvSpPr${textNode >= 0 && frame ? ' txBox="1"' : ""}/><wps:spPr><a:xfrm${transform}><a:off x="0" y="0"/><a:ext cx="${emu(placement.width)}" cy="${emu(placement.height)}"/></a:xfrm>${geometry}${fill}${line}</wps:spPr>${text}${body}</wps:wsp></a:graphicData></a:graphic>`
	}

	private textAnchor(properties: ReadonlyMap<string, string>): string {
		const vertical = properties.get("draw:textarea-vertical-align") ?? properties.get("style:vertical-pos-text")

		return vertical === "middle" ? "ctr" : vertical === "bottom" ? "b" : "t"
	}

	// A frame's fill: its background colour (fo:background-color, or draw:fill with draw:fill-color).
	private fill(properties: ReadonlyMap<string, string>, frame: boolean): string {
		const fillKind = properties.get("draw:fill")
		const background = colorOf(properties.get("fo:background-color"))
		const fillColor = colorOf(properties.get("draw:fill-color"))
		const opacity = properties.get("draw:opacity")
		const alpha = opacity === undefined ? "" : `<a:alpha val="${Math.round(Number(opacity.replace("%", "")) * 1000)}"/>`

		if (fillKind === "none") return "<a:noFill/>"
		if (fillKind === "solid" || (fillKind === undefined && !frame))
			return `<a:solidFill><a:srgbClr val="${fillColor ?? background ?? "729FCF"}">${alpha}</a:srgbClr></a:solidFill>`
		if (fillKind === "gradient" || fillKind === "hatch" || fillKind === "bitmap") {
			this.translator.lossy("shapeApproximated")

			return `<a:solidFill><a:srgbClr val="${fillColor ?? background ?? "729FCF"}"/></a:solidFill>`
		}

		return background === undefined ? "<a:noFill/>" : `<a:solidFill><a:srgbClr val="${background}"/></a:solidFill>`
	}

	// A drawing shape's outline (draw:stroke, svg:stroke-*).
	private line(graphic: OdfProperties): string {
		const properties = graphic.attributes
		const stroke = properties.get("draw:stroke")

		if (stroke === "none" || stroke === undefined) return stroke === "none" ? "<a:ln><a:noFill/></a:ln>" : ""

		const width = parseLength(properties.get("svg:stroke-width")) ?? 0
		const color = colorOf(properties.get("svg:stroke-color")) ?? "3465A4"
		const dash = stroke === "dash" ? '<a:prstDash val="dash"/>' : ""

		return `<a:ln w="${Math.max(3175, emu(width))}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${dash}</a:ln>`
	}

	// A text frame's border (fo:border); drawn as the shape outline when all sides agree.
	private frameLine(graphic: OdfProperties): string {
		const value = graphic.attributes.get("fo:border-top")

		if (value === undefined || value === "none") return "<a:ln><a:noFill/></a:ln>"

		const parts = value.trim().split(/\s+/)
		const width = parts.map(part => parseLength(part)).find(item => item !== undefined) ?? 0.75
		const color = colorOf(parts.find(part => part.startsWith("#"))) ?? "000000"

		return `<a:ln w="${emu(width)}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln>`
	}

	private shape(node: number, name: string, context: "paragraph" | "page"): string {
		const translator = this.translator
		const document = translator.document
		const attributes = translator.attributes(node)
		let placement = this.placement(node, attributes, context)
		let geometry = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
		let paths: SubPath[] | undefined
		let viewBox = viewBoxOf(attributes.get("svg:viewBox"), placement)
		let mirrorX = false
		let mirrorY = false
		let textPath = false
		let flips: { readonly h: boolean; readonly v: boolean } | undefined

		switch (name) {
			case "draw:custom-shape": {
				let enhanced = -1

				for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
					if (translator.name(child) === "draw:enhanced-geometry") enhanced = child
				}

				if (enhanced < 0) break

				const geometryAttributes = translator.attributes(enhanced)
				const path = geometryAttributes.get("draw:enhanced-path")

				// Fontwork: the path is what the text follows, not a drawn outline. The text shows plainly.
				if (geometryAttributes.get("draw:text-path") === "true") {
					translator.lossy("textEffect")
					textPath = true

					break
				}

				viewBox = viewBoxOf(geometryAttributes.get("svg:viewBox"), placement)
				mirrorX = geometryAttributes.get("draw:mirror-horizontal") === "true"
				mirrorY = geometryAttributes.get("draw:mirror-vertical") === "true"

				if (path !== undefined) {
					const equations = new Map<string, string>()

					for (let child = document.firstChildElement(enhanced); child >= 0; child = document.nextSiblingElement(child)) {
						if (translator.name(child) !== "draw:equation") continue

						const equation = translator.attributes(child)
						const equationName = equation.get("draw:name")
						const formula = equation.get("draw:formula")

						if (equationName !== undefined && formula !== undefined) equations.set(equationName, formula)
					}

					const modifiers = (geometryAttributes.get("draw:modifiers") ?? "")
						.trim()
						.split(/\s+/)
						.filter(item => item !== "")
						.map(item => Number(item) || 0)
					const evaluator = new Evaluator({
						left: viewBox.left,
						top: viewBox.top,
						width: viewBox.width,
						height: viewBox.height,
						logWidth: placement.width * (2540 / 72),
						logHeight: placement.height * (2540 / 72),
						modifiers,
						equations
					})

					paths = enhancedPath(path, evaluator)
				} else {
					// The outline the type draws (§19.145), as the DrawingML preset it is, mirrored as the shape says.
					const modifiers = (geometryAttributes.get("draw:modifiers") ?? "")
						.trim()
						.split(/\s+/u)
						.filter(item => item !== "")
						.map(item => Number(item) || 0)
					const preset = presetOfOdfType(geometryAttributes.get("draw:type") ?? "", modifiers, placement.width, placement.height)

					if (preset === undefined) translator.lossy("shapeApproximated")

					const avLst = (preset?.guides ?? [])
						.map(guide => `<a:gd name="${esc(guide.name)}" fmla="${esc(guide.formula)}"/>`)
						.join("")

					geometry = `<a:prstGeom prst="${esc(preset?.preset ?? "rect")}"><a:avLst>${avLst}</a:avLst></a:prstGeom>`
					flips = { h: mirrorX, v: preset?.invertsV === true ? !mirrorY : mirrorY }
				}

				break
			}
			case "draw:rect":
				if (parseLength(attributes.get("draw:corner-radius")) !== undefined)
					geometry = '<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>'
				break
			case "draw:ellipse":
			case "draw:circle":
				geometry = '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'

				if ((attributes.get("draw:kind") ?? "full") !== "full") translator.lossy("shapeApproximated")

				break
			case "draw:line":
			case "draw:connector":
			case "draw:measure": {
				if (name !== "draw:line") translator.lossy("shapeApproximated")

				const x1 = parseLength(attributes.get("svg:x1")) ?? 0
				const y1 = parseLength(attributes.get("svg:y1")) ?? 0
				const x2 = parseLength(attributes.get("svg:x2")) ?? 0
				const y2 = parseLength(attributes.get("svg:y2")) ?? 0

				placement = { ...placement, x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
				viewBox = {
					left: Math.min(x1, x2),
					top: Math.min(y1, y2),
					width: Math.max(Math.abs(x2 - x1), 1e-6),
					height: Math.max(Math.abs(y2 - y1), 1e-6)
				}
				paths = [
					{
						segments: [
							{ kind: "M", x: x1, y: y1 },
							{ kind: "L", x: x2, y: y2 }
						],
						fill: false,
						stroke: true
					}
				]
				break
			}
			case "draw:polyline":
			case "draw:polygon":
				paths = pointsPath(attributes.get("draw:points") ?? "", name === "draw:polygon")
				break
			case "draw:path":
				paths = svgPath(attributes.get("svg:d") ?? "")
				break
			default:
				translator.lossy("shapeApproximated")
		}

		// LibreOffice mirrors a custom shape (draw:mirror-*) after its draw:transform turns it, DrawingML before:
		// under one mirror the turn reads the other way.
		if (mirrorX !== mirrorY && placement.rotation !== 0) placement = { ...placement, rotation: 360 - placement.rotation }

		// Text inside the shape (text:p, text:list children).
		const hasText = (() => {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const childName = translator.name(child)

				if (childName === "text:p" || childName === "text:h" || childName === "text:list") return true
			}

			return false
		})()

		if (paths !== undefined) {
			// LibreOffice wraps text around what a shape draws, its path and stroke, not its frame (measured): an
			// anchored shape without text or rotation is placed as its path's bounds.
			const drawn =
				hasText || placement.rotation !== 0 || placement.anchorType === "as-char"
					? undefined
					: drawnBounds(paths, viewBox, placement, mirrorX, mirrorY !== placement.flipV)

			if (drawn !== undefined) {
				placement = { ...placement, ...drawn.placement }
				viewBox = drawn.viewBox
			}

			const stroke = placement.graphic.attributes.get("draw:stroke")

			if (stroke !== undefined && stroke !== "none" && placement.anchorType !== "as-char")
				placement = { ...placement, reach: (parseLength(placement.graphic.attributes.get("svg:stroke-width")) ?? 0) / 2 }

			geometry = customGeometry({ ...viewBox, paths }, mirrorX, mirrorY)
		}

		return this.drawing(placement, this.shapeGraphic(placement, geometry, hasText ? node : -1, false, textPath ? "text" : "own", flips))
	}
}

const ADJUSTMENTS = ["draw:luminance", "draw:contrast", "draw:red", "draw:green", "draw:blue"]

// An a:xfrm's rot attribute (60000ths of a degree, clockwise), empty when unturned.
function rotationOf(placement: Placement): string {
	const rot = Math.round(placement.rotation * 60_000) % 21_600_000

	return rot === 0 ? "" : ` rot="${rot}"`
}

// Whether fo:clip crops: rect(top, right, bottom, left) with any side not zero (LibreOffice writes a zero
// rectangle on every picture). A value that does not parse counts as a crop.
function cropped(clip: string | undefined): boolean {
	if (clip === undefined || clip === "auto") return false

	const sides = /^rect\((.*)\)$/u
		.exec(clip.trim())?.[1]
		?.trim()
		.split(/\s*,\s*|\s+/u)

	if (sides?.length !== 4) return true

	return sides.some(side => side !== "auto" && parseLength(side) !== 0)
}

// The bounds of what `paths` draw, as a placement within `placement` and the view box they fill; undefined when
// they draw nothing.
function drawnBounds(
	paths: readonly SubPath[],
	viewBox: { left: number; top: number; width: number; height: number },
	placement: Placement,
	mirrorX: boolean,
	mirrorY: boolean
):
	| {
			readonly placement: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
			readonly viewBox: { left: number; top: number; width: number; height: number }
	  }
	| undefined {
	let left = Infinity
	let top = Infinity
	let right = -Infinity
	let bottom = -Infinity
	const add = (x: number, y: number): void => {
		left = Math.min(left, x)
		top = Math.min(top, y)
		right = Math.max(right, x)
		bottom = Math.max(bottom, y)
	}

	for (const path of paths) {
		if (!path.fill && !path.stroke) continue

		for (const segment of path.segments) {
			if (segment.kind === "Z") continue

			// A curve stays inside its control points.
			if (segment.kind === "C") {
				add(segment.x1, segment.y1)
				add(segment.x2, segment.y2)
			}

			add(segment.x, segment.y)
		}
	}

	if (!Number.isFinite(left) || !Number.isFinite(top)) return undefined

	const clamp = (value: number): number => Math.min(1, Math.max(0, value))
	let x0 = clamp((left - viewBox.left) / viewBox.width)
	let x1 = clamp((right - viewBox.left) / viewBox.width)
	let y0 = clamp((top - viewBox.top) / viewBox.height)
	let y1 = clamp((bottom - viewBox.top) / viewBox.height)

	if (mirrorX) [x0, x1] = [1 - x1, 1 - x0]
	if (mirrorY) [y0, y1] = [1 - y1, 1 - y0]

	return {
		placement: {
			x: placement.x + x0 * placement.width,
			y: placement.y + y0 * placement.height,
			width: (x1 - x0) * placement.width,
			height: (y1 - y0) * placement.height
		},
		viewBox: {
			left: Math.max(left, viewBox.left),
			top: Math.max(top, viewBox.top),
			width: Math.max(Math.min(right, viewBox.left + viewBox.width) - Math.max(left, viewBox.left), 1e-6),
			height: Math.max(Math.min(bottom, viewBox.top + viewBox.height) - Math.max(top, viewBox.top), 1e-6)
		}
	}
}

const WPG = "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"

// A member's graphic (a:graphic around one pic:pic or wps:wsp at offset 0) as a child of a group at (x, y) EMU.
function groupMember(graphic: string, x: number, y: number): string {
	const inner = graphic.replace(/^<a:graphic><a:graphicData uri="[^"]*">/u, "").replace(/<\/a:graphicData><\/a:graphic>$/u, "")

	return inner.replace('<a:off x="0" y="0"/>', `<a:off x="${x}" y="${y}"/>`)
}

function viewBoxOf(value: string | undefined, placement: Placement): { left: number; top: number; width: number; height: number } {
	const numbers = (value ?? "")
		.trim()
		.split(/[\s,]+/)
		.map(Number)

	if (numbers.length === 4 && numbers.every(Number.isFinite) && (numbers[2] ?? 0) > 0 && (numbers[3] ?? 0) > 0) {
		return { left: numbers[0] ?? 0, top: numbers[1] ?? 0, width: numbers[2] ?? 1, height: numbers[3] ?? 1 }
	}

	return { left: 0, top: 0, width: Math.max(placement.width, 1e-6), height: Math.max(placement.height, 1e-6) }
}

// A package-internal href ("./Pictures/a.png", "Pictures/a.png") as a stream path; undefined for external links.
export function packagePath(href: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("../")) return undefined

	let path = href.startsWith("./") ? href.slice(2) : href

	try {
		path = decodeURIComponent(path)
	} catch {
		// Kept as written.
	}

	return path
}

// What an embedded object is, by its media type in the manifest ("chart", "formula", ...).
function objectKind(translator: Translator, href: string, element: string): string {
	if (element !== "draw:object") return element.slice("draw:".length)

	const path = packagePath(href)
	const mediaType = path === undefined ? undefined : (translator.odf.mediaTypeOf(`${path}/`) ?? translator.odf.mediaTypeOf(path))

	if (mediaType === undefined) return "object"

	const match = /opendocument\.([a-z-]+)$/.exec(mediaType)

	return match?.[1] ?? "object"
}
