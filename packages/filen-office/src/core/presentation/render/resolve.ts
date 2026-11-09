import { fillChild } from "../../drawingml/fill"
import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import type { TextBodyProps } from "../../drawingml/index"
import { inheritLevels, nearestGroup, resolveShape } from "../inherit"
import type { Deck, ShapeNode, SlideNode, Xfrm } from "../model"
import { bodyPrXml, colorXml, effectsXml, fillXml, geometryXml, lineXml, type ScratchWriter } from "./markup"
import type { PlaceholderLevel, RenderServices } from "./services"

// Resolved DrawingML elements (one per shape): xfrm, geometry, fill, line, effects and style taken from the nearest
// level of the placeholder chain that has them (typed edits in `props` first on every level, then the level's source
// group; a level's own p:style supplies fill, line and effects first, inherit.ts nearestGroup), bodyPr from the one
// resolver (inherit.ts resolveShape), text replaced by a story marker. ODP shapes and shapes without a source are
// written from the model alone. The shape converter only ever sees this element, never a source node.

// The attribute marking a text body in the scratch document with its index in the renderer's text targets.
export const TEXT_MARK = "foText"

// The placeholders a shape inherits from, nearest first (core/presentation/inherit.ts, MS-OI29500 §2.1.1127).
export function placeholderChain(deck: Deck, owner: SlideNode, shape: ShapeNode): PlaceholderLevel[] {
	return inheritLevels(deck, owner, shape).levels.slice(1)
}

// A level's source element and its properties child (spPr / grpSpPr), when the level came from DrawingML.
export interface LevelSource {
	readonly reader: DrawingReader
	readonly part: string
	readonly element: number
	readonly properties: number
}

// The element of an mc:AlternateContent the renderer draws: the Fallback when the Choice holds a14:m math (its
// Fallback is the equation as a picture), else the Choice's first drawable child, else the Fallback's.
export function drawableElement(reader: DrawingReader, node: number): number {
	if (!reader.is(node, D.MC, "AlternateContent")) {
		// A shape inside a Choice that holds math: draw its Fallback instead.
		const branch = reader.document.parent(node)
		const holder = branch < 0 ? -1 : reader.document.parent(branch)

		if (branch >= 0 && holder >= 0 && reader.is(branch, D.MC, "Choice") && reader.descendant(node, D.A14, "m") >= 0) {
			const fallback = reader.child(holder, D.MC, "Fallback")
			const element = fallback < 0 ? -1 : reader.document.firstChildElement(fallback)

			if (element >= 0) return element
		}

		return node
	}

	const document = reader.document
	let choice = -1
	let fallback = -1

	for (let branch = document.firstChildElement(node); branch >= 0; branch = document.nextSiblingElement(branch)) {
		if (choice < 0 && reader.is(branch, D.MC, "Choice")) choice = branch
		else if (reader.is(branch, D.MC, "Fallback")) fallback = branch
	}

	const first = (branch: number): number => (branch < 0 ? -1 : document.firstChildElement(branch))
	const chosen = first(choice)

	if (chosen >= 0 && reader.descendant(choice, D.A14, "m") < 0) return chosen

	return first(fallback) >= 0 ? first(fallback) : chosen
}

export function levelSource(services: RenderServices, shape: ShapeNode): LevelSource | undefined {
	const src = shape.src

	if (src?.format !== "pptx") return undefined

	const document = services.xml(src.part)

	if (document === undefined || src.node <= 0 || src.node >= document.count) return undefined

	const reader = drawingReader(document)
	const element = drawableElement(reader, src.node)
	const local = reader.local(element)
	const properties = reader.child(element, D.P, local === "grpSp" ? "grpSpPr" : "spPr")

	return { reader, part: src.part, element, properties: properties >= 0 ? properties : reader.child(element, D.Dsp, "spPr") }
}

export interface ResolveLevel {
	readonly node: SlideNode
	readonly shape: ShapeNode
	readonly source: LevelSource | undefined
}

export function resolveLevels(
	services: RenderServices,
	owner: SlideNode,
	shape: ShapeNode,
	chain: readonly PlaceholderLevel[]
): ResolveLevel[] {
	return [{ node: owner, shape }, ...chain].map(level => ({ ...level, source: levelSource(services, level.shape) }))
}

// a:off and a:ext carry no defaults, so a shape that no level places gets the hard-coded default of MS-OI29500
// §2.1.1284 (no style link or master shape supplies one): a zero box at the origin, never the slide.
const ABSENT_XFRM: Xfrm = { x: 0, y: 0, cx: 0, cy: 0, rot: 0, flipH: false, flipV: false }

// The nearest xfrm along the chain.
export function resolvedXfrm(levels: readonly ResolveLevel[]): Xfrm {
	for (const level of levels) if (level.shape.xfrm !== undefined) return level.shape.xfrm

	return ABSENT_XFRM
}

const GEOMETRIES: ReadonlySet<string> = new Set(["prstGeom", "custGeom"])
export const EFFECTS: ReadonlySet<string> = new Set(["effectLst", "effectDag"])

function pictureImage(writer: ScratchWriter): Parameters<typeof fillXml>[1] {
	return fill =>
		fill.part !== undefined
			? writer.target(fill.part)
			: fill.inserted !== undefined
				? writer.target(`inserted:${String(fill.inserted)}`)
				: undefined
}

// Writes the first group found along the chain: the level's typed edit, else its source element. `styled` groups
// stop at a level with its own p:style (inherit.ts nearestGroup).
function group(
	writer: ScratchWriter,
	levels: readonly ResolveLevel[],
	styled: boolean,
	edit: (level: ResolveLevel) => string | undefined,
	source: (source: LevelSource) => number
): boolean {
	const found = nearestGroup<ResolveLevel, { markup: string } | { source: LevelSource; node: number }>(levels, styled, level => {
		const edited = edit(level)

		if (edited !== undefined) return { markup: edited }
		if (level.source === undefined) return undefined

		const node = source(level.source)

		return node >= 0 ? { source: level.source, node } : undefined
	})

	if (found === undefined) return false
	if ("markup" in found) {
		writer.push(found.markup)

		return true
	}

	return writer.copy(found.source.reader, found.source.part, found.node)
}

export function writeXfrm(writer: ScratchWriter, xfrm: Xfrm, local: boolean): void {
	const rot = local ? 0 : xfrm.rot
	const children =
		xfrm.chCx === undefined || xfrm.chCy === undefined
			? ""
			: `<a:chOff x="${String(Math.round(xfrm.chX ?? 0))}" y="${String(Math.round(xfrm.chY ?? 0))}"/><a:chExt cx="${String(Math.round(xfrm.chCx))}" cy="${String(Math.round(xfrm.chCy))}"/>`
	const x = local ? 0 : Math.round(xfrm.x)
	const y = local ? 0 : Math.round(xfrm.y)

	writer.push(
		`<a:xfrm${rot === 0 ? "" : ` rot="${String(Math.round(rot))}"`}${xfrm.flipH ? ' flipH="1"' : ""}${xfrm.flipV ? ' flipV="1"' : ""}>` +
			`<a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="${String(Math.max(0, Math.round(xfrm.cx)))}" cy="${String(Math.max(0, Math.round(xfrm.cy)))}"/>${children}</a:xfrm>`
	)
}

// The shape properties of a resolved element: xfrm, geometry, fill, line and effects, each from the nearest level.
// `fill` false leaves the fill out (a picture's blip fill is written apart).
export function writeProperties(
	writer: ScratchWriter,
	levels: readonly ResolveLevel[],
	xfrm: Xfrm,
	local: boolean,
	withFill: boolean = true
): void {
	const image = pictureImage(writer)

	writer.push("<p:spPr>")
	writeXfrm(writer, xfrm, local)
	group(
		writer,
		levels,
		false,
		level => (level.shape.props?.geometry === undefined ? undefined : geometryXml(level.shape.props.geometry)),
		source => source.reader.childOf(source.properties, D.A, GEOMETRIES)
	)

	if (withFill)
		group(
			writer,
			levels,
			true,
			level => {
				const fill = level.shape.props?.fill

				return fill === undefined || (fill !== "none" && fill.kind === "picture" && level.shape.kind === "pic")
					? undefined
					: fillXml(fill, image)
			},
			source => fillChild(source.reader, source.properties)
		)

	group(
		writer,
		levels,
		true,
		level => (level.shape.props?.ln === undefined ? undefined : lineXml(level.shape.props.ln, image)),
		source => source.reader.child(source.properties, D.A, "ln")
	)
	group(
		writer,
		levels,
		true,
		level => {
			const effects = level.shape.props?.effects

			return effects === undefined || effects.src !== undefined ? undefined : effectsXml(effects)
		},
		source => source.reader.childOf(source.properties, D.A, EFFECTS)
	)
	writer.push("</p:spPr>")
}

// p:style: the nearest level's source style, else its typed style references.
export function writeStyle(writer: ScratchWriter, levels: readonly ResolveLevel[]): void {
	group(
		writer,
		levels,
		false,
		level => {
			const style = level.shape.style

			if (style === undefined || level.source !== undefined) return undefined

			const ref = (name: string, idx: number, color: Parameters<typeof colorXml>[0] | undefined): string =>
				`<a:${name} idx="${String(idx)}">${color === undefined ? "" : colorXml(color)}</a:${name}>`

			return (
				`<p:style>${ref("lnRef", style.ln.idx, style.ln.color)}${ref("fillRef", style.fill.idx, style.fill.color)}` +
				`${ref("effectRef", style.effect.idx, style.effect.color)}<a:fontRef idx="${style.font.idx}">${style.font.color === undefined ? "" : colorXml(style.font.color)}</a:fontRef></p:style>`
			)
		},
		source => source.reader.child(source.element, D.P, "style")
	)
}

// bodyPr from the one resolver: attribute by attribute along the chain, then the ECMA defaults.
export function resolvedBodyPr(deck: Deck, owner: SlideNode, shape: ShapeNode): TextBodyProps {
	return resolveShape(deck, owner.ref, shape).bodyPr
}

// The text body marker: the resolved bodyPr inside a p:txBody the converter maps to a story.
export function writeTextMarker(writer: ScratchWriter, index: number, body: TextBodyProps): void {
	writer.push(`<p:txBody ${TEXT_MARK}="${String(index)}">${bodyPrXml(body)}</p:txBody>`)
}

// The picture's blip fill: the nearest level's typed picture fill, else its source blipFill.
export function writeBlipFill(writer: ScratchWriter, levels: readonly ResolveLevel[]): void {
	const image = pictureImage(writer)
	const wrote = group(
		writer,
		levels,
		false,
		level => {
			const fill = level.shape.props?.fill

			return fill !== undefined && fill !== "none" && fill.kind === "picture"
				? fillXml(fill, image)
						.replace(/^<a:blipFill>/, "<p:blipFill>")
						.replace(/<\/a:blipFill>$/, "</p:blipFill>")
				: undefined
		},
		source => source.reader.child(source.element, D.P, "blipFill")
	)

	if (!wrote) writer.push("<p:blipFill/>")
}

export function hasText(shape: ShapeNode): boolean {
	return shape.text?.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "br" && run.text !== "")) === true
}
