import { readColorIn, type DrawingTheme } from "../../drawingml/color"
import { rgbaHex } from "../../drawingml/displayList"
import type { DrawingReader } from "../../drawingml/reader"
import { childByLocal } from "../../xlsx/refs/markup"
import { escapeAttribute, type XmlDocument } from "../../xml/index"
import { paragraphText } from "../write/cells"
import { odfPresetAttributes } from "../../odf/presetShapes"

// Shapes, text boxes, connectors and groups of a sheet's drawing (ECMA-376 Part 1 §20.5.2.29 sp, §20.5.2.13 cxnSp,
// §20.5.2.17 grpSp) as OpenDocument shapes (ODF 1.3 Part 3 §10.3): a preset geometry LibreOffice knows as a
// draw:custom-shape of that type (§10.6.1, §19.145 draw:type), a rectangle and an ellipse with their paths, a
// connector as a draw:line, a group as a draw:g; each shape's text as its paragraphs, their runs' fonts, the shape's
// fill and outline as a graphic style. What is lost: a preset no ODF type names (drawn as a rectangle), a custom
// geometry, fills other than a colour, effects, rotated text.

const EMU_PER_CM = 360_000

// The paths ODF itself gives the two commonest, for readers without LibreOffice's types (§19.145 draw:enhanced-path).
const PATHS: Readonly<Record<string, string>> = {
	rectangle: "M 0 0 L 21600 0 21600 21600 0 21600 Z N",
	ellipse: "U 10800 10800 10800 10800 0 360 Z N"
}

// Straight connectors (§20.1.10.56) as lines; the others drawn straight are lost.
const STRAIGHT: ReadonlySet<string> = new Set(["line", "straightConnector1"])

export interface Box {
	readonly x: number
	readonly y: number
	readonly cx: number
	readonly cy: number
}

function length(emu: number): string {
	return `${String(Math.round((emu / EMU_PER_CM) * 1000) / 1000)}cm`
}

function attributes(pairs: readonly (readonly [string, string | undefined])[]): string {
	return pairs.map(([name, value]) => (value === undefined ? "" : ` ${name}="${escapeAttribute(value)}"`)).join("")
}

function children(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let child = node < 0 ? -1 : document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		out.push(child)

	return out
}

function number(document: XmlDocument, node: number, name: string, fallback: number): number {
	const value = Number(node < 0 ? Number.NaN : (document.attribute(node, name) ?? Number.NaN))

	return Number.isFinite(value) ? value : fallback
}

// Common styles of the package's styles.xml for the shapes (graphic, paragraph and text families), each the same once.
export class ShapeStyles {
	private readonly names = new Map<string, string>()
	private readonly markup: string[] = []

	get styles(): string {
		return this.markup.join("")
	}

	style(family: "graphic" | "paragraph" | "text", properties: string): string {
		const key = `${family}\u0000${properties}`
		let name = this.names.get(key)

		if (name === undefined) {
			name = `Shape${family === "graphic" ? "" : family === "paragraph" ? "P" : "T"}${String(this.names.size + 1)}`
			this.names.set(key, name)
			this.markup.push(`<style:style style:name="${name}" style:family="${family}">${properties}</style:style>`)
		}

		return name
	}
}

export class ShapeWriter {
	private readonly document: XmlDocument
	private readonly reader: DrawingReader
	private readonly theme: DrawingTheme
	private readonly styles: ShapeStyles
	lost = 0

	constructor(document: XmlDocument, reader: DrawingReader, theme: DrawingTheme, styles: ShapeStyles) {
		this.document = document
		this.reader = reader
		this.theme = theme
		this.styles = styles
	}

	private child(node: number, local: string): number {
		return node < 0 ? -1 : childByLocal(this.document, node, local)
	}

	// A colour inside a container (a:solidFill, a style reference), as #rrggbb.
	private color(container: number): string | undefined {
		if (container < 0) return undefined

		const color = readColorIn(this.reader, container, this.theme)

		return color === undefined ? undefined : `#${rgbaHex(color).slice(0, 6).toLowerCase()}`
	}

	// The fill and outline of spPr, falling back to the shape's style references (xdr:style, §20.1.4.2.10).
	private graphic(spPr: number, style: number, line: boolean): [string, string | undefined][] {
		const out: [string, string | undefined][] = []
		const fillRef = this.child(style, "fillRef")
		const lnRef = this.child(style, "lnRef")

		if (!line) {
			if (this.child(spPr, "noFill") >= 0) out.push(["draw:fill", "none"])
			else {
				const solid = this.child(spPr, "solidFill")
				const gradient = this.child(spPr, "gradFill")
				const stop = this.child(this.child(gradient, "gsLst"), "gs")
				const own = solid >= 0 ? this.color(solid) : gradient >= 0 ? this.color(stop) : undefined

				if (gradient >= 0 || this.child(spPr, "pattFill") >= 0 || this.child(spPr, "blipFill") >= 0) this.lost++

				const color = own ?? (fillRef >= 0 && number(this.document, fillRef, "idx", 0) > 0 ? this.color(fillRef) : undefined)

				out.push(["draw:fill", color === undefined ? "none" : "solid"], ["draw:fill-color", color])
			}
		}

		const ln = this.child(spPr, "ln")

		if (this.child(ln, "noFill") >= 0) out.push(["draw:stroke", "none"])
		else {
			const color =
				this.color(this.child(ln, "solidFill")) ??
				(lnRef >= 0 && number(this.document, lnRef, "idx", 0) > 0 ? this.color(lnRef) : undefined)
			const width = number(this.document, ln, "w", 9525)
			const dash = this.document.attribute(this.child(ln, "prstDash"), "val")

			if (dash !== undefined && dash !== "solid") this.lost++

			out.push(
				["draw:stroke", color === undefined ? "none" : "solid"],
				["svg:stroke-color", color],
				["svg:stroke-width", color === undefined ? undefined : length(width)]
			)
		}

		// Effects, 3-D scenes and bevels (§20.1.8.26, §20.1.4.1.26, §20.1.5.12) have no home in a graphic style.
		if (
			(this.child(spPr, "effectLst") >= 0 && children(this.document, this.child(spPr, "effectLst")).length > 0) ||
			this.child(spPr, "scene3d") >= 0 ||
			this.child(spPr, "sp3d") >= 0
		)
			this.lost++

		return out
	}

	// A text body's paragraphs (§21.1.2.2.2), each run in its font.
	private text(body: number, style: number): { paragraphs: string; graphic: [string, string | undefined][] } {
		const document = this.document
		const bodyPr = this.child(body, "bodyPr")
		const fontRef = this.child(style, "fontRef")
		const defaultColor = this.color(fontRef) ?? "#000000"
		const anchor = document.attribute(bodyPr, "anchor") ?? "t"
		const graphic: [string, string | undefined][] = [
			["draw:textarea-vertical-align", anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top"],
			["draw:auto-grow-height", "false"],
			["draw:auto-grow-width", "false"],
			["fo:wrap-option", document.attribute(bodyPr, "wrap") === "none" ? "no-wrap" : "wrap"],
			["fo:padding-left", length(number(document, bodyPr, "lIns", 91_440))],
			["fo:padding-right", length(number(document, bodyPr, "rIns", 91_440))],
			["fo:padding-top", length(number(document, bodyPr, "tIns", 45_720))],
			["fo:padding-bottom", length(number(document, bodyPr, "bIns", 45_720))]
		]

		if (number(document, bodyPr, "rot", 0) !== 0 || (document.attribute(bodyPr, "vert") ?? "horz") !== "horz") this.lost++

		const paragraphs = children(document, body)
			.filter(node => document.localName(node) === "p")
			.map(p => {
				const pPr = this.child(p, "pPr")
				const align = document.attribute(pPr, "algn")
				const paragraphStyle = this.styles.style(
					"paragraph",
					`<style:paragraph-properties fo:text-align="${align === "ctr" ? "center" : align === "r" ? "end" : align === "just" ? "justify" : "start"}"/>`
				)
				let inner = ""

				for (const node of children(document, p)) {
					const local = document.localName(node)

					if (local === "br") inner += "<text:line-break/>"
					if (local !== "r" && local !== "fld") continue

					const rPr = this.child(node, "rPr")
					const text = document.textContent(this.child(node, "t"))
					const size = number(document, rPr, "sz", 1100) / 100
					const family = document.attribute(this.child(rPr, "latin"), "typeface") ?? this.theme.minorFont.latin
					const underline = document.attribute(rPr, "u")
					const properties = attributes([
						["fo:font-family", family === "" || family.startsWith("+") ? this.theme.minorFont.latin || undefined : family],
						["fo:font-size", `${String(size)}pt`],
						["fo:font-weight", /^(1|true)$/.test(document.attribute(rPr, "b") ?? "") ? "bold" : undefined],
						["fo:font-style", /^(1|true)$/.test(document.attribute(rPr, "i") ?? "") ? "italic" : undefined],
						["style:text-underline-style", underline === undefined || underline === "none" ? undefined : "solid"],
						["style:text-underline-width", underline === undefined || underline === "none" ? undefined : "auto"],
						["style:text-underline-color", underline === undefined || underline === "none" ? undefined : "font-color"],
						[
							"style:text-line-through-style",
							(document.attribute(rPr, "strike") ?? "noStrike") === "noStrike" ? undefined : "solid"
						],
						["fo:color", this.color(this.child(rPr, "solidFill")) ?? defaultColor]
					])
					let body: string

					try {
						body = paragraphText(text)
					} catch {
						this.lost++
						body = paragraphText(xmlChars(text))
					}

					inner += `<text:span text:style-name="${this.styles.style("text", `<style:text-properties${properties}/>`)}">${body}</text:span>`
				}

				return `<text:p text:style-name="${paragraphStyle}">${inner}</text:p>`
			})
			.join("")

		return { paragraphs, graphic }
	}

	// The placement of a shape: svg:x and svg:y, or draw:transform when it turns (about its centre, §19.228).
	private placement(box: Box, rotation: number): [string, string | undefined][] {
		if (rotation === 0)
			return [
				["svg:x", length(box.x)],
				["svg:y", length(box.y)]
			]

		const theta = (rotation * Math.PI) / 180
		const cx = box.x + box.cx / 2
		const cy = box.y + box.cy / 2
		const tx = cx - ((box.cx / 2) * Math.cos(theta) - (box.cy / 2) * Math.sin(theta))
		const ty = cy - ((box.cx / 2) * Math.sin(theta) + (box.cy / 2) * Math.cos(theta))

		return [["draw:transform", `rotate (${String(-theta)}) translate (${length(tx)} ${length(ty)})`]]
	}

	// One object (sp, cxnSp, grpSp) in `box`; `z` its draw:z-index, null inside a group.
	shape(node: number, box: Box, z: number | null, name: string): string {
		const document = this.document
		const local = document.localName(node)
		const spPr = this.child(node, local === "grpSp" ? "grpSpPr" : "spPr")
		const xfrm = this.child(spPr, "xfrm")
		const rotation = number(document, xfrm, "rot", 0) / 60_000
		const flipH = /^(1|true)$/.test(document.attribute(xfrm, "flipH") ?? "")
		const flipV = /^(1|true)$/.test(document.attribute(xfrm, "flipV") ?? "")
		const common: [string, string | undefined][] = [
			["draw:z-index", z === null ? undefined : String(z)],
			["draw:name", name === "" ? undefined : name]
		]

		if (local === "grpSp") {
			const chOff = this.child(xfrm, "chOff")
			const chExt = this.child(xfrm, "chExt")
			const ox = number(document, chOff, "x", 0)
			const oy = number(document, chOff, "y", 0)
			const sx = box.cx / Math.max(1, number(document, chExt, "cx", box.cx))
			const sy = box.cy / Math.max(1, number(document, chExt, "cy", box.cy))

			if (rotation !== 0 || flipH || flipV) this.lost++

			let inner = ""

			for (const member of children(document, node)) {
				const kind = document.localName(member)

				if (kind !== "sp" && kind !== "cxnSp" && kind !== "grpSp") {
					if (kind !== "nvGrpSpPr" && kind !== "grpSpPr") this.lost++

					continue
				}

				const own = this.child(this.child(member, kind === "grpSp" ? "grpSpPr" : "spPr"), "xfrm")
				const off = this.child(own, "off")
				const ext = this.child(own, "ext")
				const memberBox: Box = {
					x: box.x + (number(document, off, "x", 0) - ox) * sx,
					y: box.y + (number(document, off, "y", 0) - oy) * sy,
					cx: number(document, ext, "cx", 0) * sx,
					cy: number(document, ext, "cy", 0) * sy
				}
				const memberName =
					document.attribute(
						this.child(this.child(member, kind === "grpSp" ? "nvGrpSpPr" : kind === "sp" ? "nvSpPr" : "nvCxnSpPr"), "cNvPr"),
						"name"
					) ?? ""

				inner += this.shape(member, memberBox, null, memberName)
			}

			return `<draw:g${attributes(common)}>${inner}</draw:g>`
		}

		const style = this.child(node, "style")
		const geometry = this.child(spPr, "prstGeom")
		const preset = document.attribute(geometry, "prst")

		if (local === "cxnSp" || preset === "line") {
			if (preset === undefined || !STRAIGHT.has(preset)) this.lost++

			const ends = this.child(this.child(spPr, "ln"), "tailEnd")

			if (ends >= 0 && (document.attribute(ends, "type") ?? "none") !== "none") this.lost++

			const graphic = this.styles.style("graphic", `<style:graphic-properties${attributes(this.graphic(spPr, style, true))}/>`)
			const [x1, x2] = flipH ? [box.x + box.cx, box.x] : [box.x, box.x + box.cx]
			const [y1, y2] = flipV ? [box.y + box.cy, box.y] : [box.y, box.y + box.cy]

			if (rotation !== 0) this.lost++

			return `<draw:line${attributes([
				...common,
				["draw:style-name", graphic],
				["svg:x1", length(x1)],
				["svg:y1", length(y1)],
				["svg:x2", length(x2)],
				["svg:y2", length(y2)]
			])}><text:p/></draw:line>`
		}

		// a:avLst (§20.1.9.5): the adjust values the shape gives its preset.
		const guides = children(document, this.child(geometry, "avLst"))
			.filter(gd => document.localName(gd) === "gd")
			.map(gd => ({ name: document.attribute(gd, "name") ?? "", formula: document.attribute(gd, "fmla") ?? "" }))
		let outline = preset === undefined ? undefined : odfPresetAttributes(preset, guides, { cx: box.cx, cy: box.cy, flipH, flipV })

		// A custom geometry, or no preset: its box, drawn as a rectangle.
		if (outline === undefined) {
			this.lost++
			outline = odfPresetAttributes("rect", [], { cx: box.cx, cy: box.cy, flipH, flipV }) ?? []
		}

		// The paths ODF itself gives the two commonest, for readers without LibreOffice's types.
		const type = outline.find(([name]) => name === "draw:type")?.[1] ?? ""
		const path = PATHS[type]
		const enhanced =
			path === undefined
				? outline
				: outline.flatMap(entry => (entry[0] === "draw:type" ? [entry, ["draw:enhanced-path", path] as const] : [entry]))

		const body = this.child(node, "txBody")
		const text = body < 0 ? { paragraphs: "", graphic: [] } : this.text(body, style)
		const graphic = this.styles.style(
			"graphic",
			`<style:graphic-properties${attributes([...this.graphic(spPr, style, false), ...text.graphic])}/>`
		)
		return (
			`<draw:custom-shape${attributes([
				...common,
				["draw:style-name", graphic],
				["svg:width", length(box.cx)],
				["svg:height", length(box.cy)],
				...this.placement(box, rotation)
			])}>${text.paragraphs}` +
			`<draw:enhanced-geometry${attributes(enhanced.map(([name, value]): [string, string] => [name, value]))}/></draw:custom-shape>`
		)
	}
}

// Text without the characters XML cannot hold (a line feed and a tab stay).
function xmlChars(text: string): string {
	let out = ""

	for (const char of text) {
		const code = char.charCodeAt(0)

		if (code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0xfffe && code !== 0xffff)) out += char
	}

	return out
}
