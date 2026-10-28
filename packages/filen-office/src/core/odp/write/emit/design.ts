import { canonicalName, type OdfStyle } from "../../../odf/index"
import { parseLength } from "../../../odf/units"
import {
	boxesMovedSinceBase,
	galleryDesigns,
	heldStyles,
	pageMappingSinceBase,
	textScaleOf,
	type GalleryDesign,
	type PageMapping
} from "../../../presentation/edit/apply/design"
import {
	refused,
	type Background,
	type Deck,
	type FillProps,
	type Refused,
	type ShapeNode,
	type SlideRef
} from "../../../presentation/model"
import { filenTheme } from "../../../templates/themes/catalog"
import { themeName } from "../../../templates/themes/model"
import { cm as themeCm, odpGalleryMaster } from "../../../templates/themes/odp"
import { NodeKind, XmlEditor } from "../../../xml/index"
import type { Fragment } from "../../read/context"
import type { OdpEmitContext, OdpEmitFamily, OdpStylesApi } from "../emit"
import { resourceFillChanges, type DrawResourceSink } from "../resources"
import {
	OdpStyles,
	WRITTEN_NAMESPACES,
	cm,
	declared,
	hexColor,
	isRefused,
	pt,
	setProperty,
	styleChanges,
	type StyleChanges
} from "../styles"
import { pictureFillEntry } from "./picture"
import { IDENTITY, compose, groupAffine, lineEnds, placed, type Affine } from "./shape"

// The design family's ODF: a page's background as its drawing-page style's fill (ODF 1.3 Part 3 §20.137 draw:fill,
// §20.146 draw:fill-color on style:drawing-page-properties §17.25), joined to the page style the slide family derives.
// A gradient, pattern or picture is a drawing resource of styles.xml's office:styles (§16.40 draw:gradient, §16.42
// draw:fill-image, §16.44 draw:opacity), written as the shape fills are (resources.ts): a pattern as LibreOffice's own
// pattern fill, its 8 × 8 tile repeated; a picture once per distinct image however many pages show it. What ODF holds
// only nearly (more than two gradient stops, a cropped picture) is refused, never written changed. A theme is a
// master page: the slide family writes the master references, odpDesignStyles the gallery's master pages.

const FILL_PROPERTIES = [
	"draw:fill",
	"draw:fill-color",
	"draw:opacity",
	"draw:opacity-name",
	"draw:fill-gradient-name",
	"draw:gradient-step-count",
	"draw:fill-hatch-name",
	"draw:fill-hatch-solid",
	"draw:fill-image-name",
	"draw:fill-image-width",
	"draw:fill-image-height",
	"draw:fill-image-ref-point",
	"draw:fill-image-ref-point-x",
	"draw:fill-image-ref-point-y",
	"draw:tile-repeat-offset",
	"style:repeat"
] as const

type ResourceElement = Parameters<DrawResourceSink["named"]>[0]

// The drawing resources a source save adds to styles.xml: named past every name the file has for the element, each
// distinct one once; a pattern's tile stored once per distinct bytes. What was written only nearly is kept in
// `approximations` (the caller refuses it).
class SourceDrawResources implements DrawResourceSink {
	readonly elements: string[] = []
	approximations: string[] = []
	private readonly names = new Map<string, string>()
	private readonly tiles = new Map<string, string>()
	private readonly styles: OdpStylesApi
	private readonly taken: (element: ResourceElement, name: string) => boolean

	constructor(styles: OdpStylesApi, taken: (element: ResourceElement, name: string) => boolean) {
		this.styles = styles
		this.taken = taken
	}

	named(element: ResourceElement, attributes: string): string {
		const key = `${element} ${attributes}`
		const held = this.names.get(key)

		if (held !== undefined) return held

		const stem = `Filen${element.slice(5).replace(/(^|-)./gu, part => (part.at(-1) ?? "").toUpperCase())}`
		let name = ""

		for (let n = this.names.size + 1; name === "" || this.taken(element, name); n++) name = `${stem}${String(n)}`

		this.names.set(key, name)
		this.elements.push(`<${element} draw:name="${name}"${attributes}/>`)

		return name
	}

	picture(bytes: Uint8Array, extension: string): string {
		let key = extension

		for (const byte of bytes) key += `,${String(byte)}`

		const held = this.tiles.get(key)

		if (held !== undefined) return held

		let path = ""

		for (let n = this.tiles.size + 1; path === "" || this.styles.hasEntry?.(path) === true; n++)
			path = `Pictures/filen-tile${String(n)}.${extension}`

		this.styles.addEntry(path, bytes, extension === "png" ? "image/png" : `image/${extension}`)
		this.tiles.set(key, path)

		return path
	}

	part(part: string): string | undefined {
		const path = part.startsWith("/") ? part.slice(1) : part

		return this.styles.hasEntry === undefined || this.styles.hasEntry(path) ? path : undefined
	}

	approximated(what: string): void {
		this.approximations.push(what)
	}
}

// One sink per save (its OdpStyles): the slide family's pages and odpDesignStyles share it.
const RESOURCES = new WeakMap<OdpStylesApi, SourceDrawResources>()

function resourcesOf(styles: OdpStylesApi): SourceDrawResources {
	let sink = RESOURCES.get(styles)

	if (sink === undefined) {
		const sheet = styles instanceof OdpStyles ? styles.sheet : undefined

		sink = new SourceDrawResources(styles, (element, name) => sheet?.drawResources.get(element)?.has(name) === true)
		RESOURCES.set(styles, sink)
	}

	return sink
}

// The page style changes for a slide's background (undefined: the page inherits its master page's).
export function odpBackgroundStyle(
	changes: StyleChanges,
	background: Background | undefined,
	context: OdpEmitContext
): Refused | undefined {
	for (const name of FILL_PROPERTIES) setProperty(changes, "drawing-page", name, null)

	if (background === undefined) return undefined
	if (background.kind === "ref") return refused("unsupported", "a theme background style in an ODP deck")

	const fill = background.fill

	if (fill.kind === "solid") {
		const color = hexColor(fill.color)

		if (isRefused(color)) return color

		setProperty(changes, "drawing-page", "draw:fill", "solid")
		setProperty(changes, "drawing-page", "draw:fill-color", color)
		setProperty(changes, "drawing-page", "draw:background-size", "full")

		return undefined
	}

	if (fill.kind === "group") return refused("unsupported", "a group fill as a page background")
	// A gradient needs its two ends (draw:start-color, draw:end-color): one without stops has nothing to write.
	if (fill.kind === "gradient" && fill.stops.length === 0) return refused("unsupported", "a gradient background without stops")

	let written: FillProps = fill

	if (fill.kind === "picture" && fill.inserted !== undefined) {
		const entry = pictureFillEntry(context, fill)

		if (isRefused(entry)) return entry

		const { inserted: _inserted, ...rest } = fill

		written = { ...rest, part: `/${entry}` }
	}

	const sink = resourcesOf(context.styles)
	const before = sink.approximations.length

	if (!resourceFillChanges(changes, written, sink, "drawing-page")) return refused("notFound", "the picture of the page's background")

	const approximated = sink.approximations.slice(before)

	if (approximated.length > 0) {
		sink.approximations = sink.approximations.slice(0, before)

		return refused("unsupported", `a page background ODF holds only nearly: ${approximated.join(", ")}`)
	}

	setProperty(changes, "drawing-page", "draw:background-size", "full")

	return undefined
}

// Asked by the slide family for a page's background: a refusal when the background cannot be written, else
// "unchanged" (the slide family writes the properties into the page style, odpBackgroundStyle).
export const emitOdpDesign: OdpEmitFamily = {
	emit(request, context) {
		if (request.shape !== undefined) return refused("unsupported", "odp emit design: a shape's element")

		const refusal = odpBackgroundStyle(styleChanges(), request.slide.background, context)

		return refusal ?? { kind: "unchanged" }
	}
}

// --- styles.xml: the slide size ---

const EMU_PER_PT = 12_700

// styles.xml after a slide size change (§20.215 fo:page-width/height on the master pages' page layouts, §16.5), with
// each master page shape the change moved written at its new box (moveShapes); undefined when nothing differs.
export function odpSizedStyles(deck: Deck, fragment: Fragment): Uint8Array | Refused | undefined {
	const editor = new XmlEditor(fragment.document)
	const refusal = sizeEdits(deck, fragment, editor)

	if (refusal !== undefined) return refusal

	return editor.changed ? editor.serialize() : undefined
}

function sizeEdits(deck: Deck, fragment: Fragment, editor: XmlEditor): Refused | undefined {
	const document = fragment.document
	const layouts = new Set<string>()
	// An attribute under the name the element writes it with (its own prefix), else the canonical one.
	const set = (node: number, canonical: string, value: string): void => {
		const raw = document.attributes(node).find(attribute => {
			const colon = attribute.name.indexOf(":")

			return (
				colon > 0 &&
				canonicalName(fragment.namespaces.uri(node, attribute.name.slice(0, colon)), attribute.name.slice(colon + 1)) === canonical
			)
		})

		editor.setAttribute(node, raw?.name ?? canonical, value)
	}

	for (const ref of deck.masters) {
		const master = deck.nodes.get(ref)
		const src = master?.src

		if (master === undefined || src?.format !== "odp" || src.part !== fragment.part) continue

		const layout = fragment.attributes(src.node).get("style:page-layout-name")

		if (layout !== undefined) layouts.add(layout)

		// Nothing moved since the file was read: every master shape stands where the file has it.
		const refusal = boxesMovedSinceBase(deck) ? moveShapes(master.shapes, fragment, set, pageMappingSinceBase(deck)) : undefined

		if (refusal !== undefined) return refusal
	}

	for (let node = 1; node < document.count; node++) {
		if (fragment.name(node) !== "style:page-layout" || !layouts.has(fragment.attributes(node).get("style:name") ?? "")) continue

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (fragment.name(child) !== "style:page-layout-properties") continue

			set(child, "fo:page-width", cm(deck.size.cx))
			set(child, "fo:page-height", cm(deck.size.cy))
		}
	}

	scaleFontSizes(deck, fragment, set)

	return undefined
}

const FONT_SIZES = ["fo:font-size", "style:font-size-asian", "style:font-size-complex"] as const

// The text sizes a scaled change scales with the content, as the model's ContentScaler does: font sizes (§20.190
// fo:font-size and its Asian and complex twins) and point paragraph spacing (§20.209 fo:margin-top, §20.206
// fo:margin-bottom, §20.204 fo:line-height, §20.317 style:line-height-at-least), each by properties kind with the
// model's range (hundredths of a point). A percentage scales with what it is relative to.
const SCALED_SIZES = [
	{ kind: "text", element: "style:text-properties", names: FONT_SIZES, range: [100, 400_000] },
	{
		kind: "paragraph",
		element: "style:paragraph-properties",
		names: ["fo:margin-top", "fo:margin-bottom", "fo:line-height", "style:line-height-at-least"],
		range: [0, 158_400]
	}
] as const

// A length at `scale`, rounded as the reader and the model round it (hundredths of a point), so that what is written
// reads back as the model holds it; undefined for what is not an absolute length.
function scaledLength(value: string | undefined, scale: number, [min, max]: readonly [number, number]): string | undefined {
	const points = parseLength(value)

	return points === undefined ? undefined : pt(Math.min(max, Math.max(min, Math.round(Math.round(points * 100) * scale))) / 100)
}

// The style names a gallery design brought (its master page name and a separator, as galleryEdits takes them out).
function galleryOwned(deck: Deck): (name: string) => boolean {
	const masters = [...galleryDesigns(deck).values()].map(design => design.names.master)

	return name => masters.some(master => name === master || name.startsWith(`${master}_`) || name.startsWith(`${master}-`))
}

// The styles only notes pages use: named by something inside a master page's presentation:notes (§16.19) and by
// nothing outside one.
function notesOnly(fragment: Fragment): Set<string> {
	const document = fragment.document
	const inNotes = new Uint8Array(document.count)
	const inside = new Set<string>()
	const outside = new Set<string>()

	for (let node = 1; node < document.count; node++) {
		if (document.kind(node) !== NodeKind.Element) continue

		const parent = document.parent(node)

		inNotes[node] = fragment.name(node) === "presentation:notes" || (parent > 0 && inNotes[parent] === 1) ? 1 : 0

		for (const attribute of document.attributes(node))
			if (attribute.name.endsWith("style-name")) (inNotes[node] === 1 ? inside : outside).add(attribute.value)
	}

	for (const name of outside) inside.delete(name)

	return inside
}

// The text sizes of styles.xml (the master pages' presentation styles, the default style) at the text scale the content
// took, as LibreOffice scales a master's presentation styles with its objects. Left as they are: the notes styles (a
// "-notes" presentation style, a style only notes pages use: a notes page keeps its size, and the change does not
// scale its text), and a gallery design's styles (made again at the new size from the theme, its sizes the theme's).
function scaleFontSizes(deck: Deck, fragment: Fragment, set: (node: number, canonical: string, value: string) => void): void {
	const scale = textScaleOf(deck)

	if (scale === 1) return

	const document = fragment.document
	const root = document.documentElement()
	const owned = galleryOwned(deck)
	const notes = notesOnly(fragment)
	const kept = new Map<number, boolean>()

	for (let node = 1; node < document.count; node++) {
		const sizes = SCALED_SIZES.find(each => each.element === fragment.name(node))

		if (sizes === undefined) continue

		// The style holding the properties: the child of a container of the root.
		let top = node

		while (top > 0 && document.parent(top) > 0 && document.parent(document.parent(top)) !== root) top = document.parent(top)

		let keep = kept.get(top)

		if (keep === undefined) {
			const style = fragment.attributes(top)
			const name = style.get("style:name") ?? ""

			keep = owned(name) || notes.has(name) || (style.get("style:family") === "presentation" && name.endsWith("-notes"))
			kept.set(top, keep)
		}

		if (keep) continue

		const attributes = fragment.attributes(node)

		for (const each of sizes.names) {
			const value = scaledLength(attributes.get(each), scale, sizes.range)

			if (value !== undefined) set(node, each, value)
		}
	}
}

// A source shape's own style as a written shape takes it while the content is at a text scale since the base file was
// read (a scaled slide size change): its own text sizes scaled, as the reader lays them over every level of the
// shape's text (the shape's lstStyle, which the change scaled in the model). Each value comes from the base file's
// style, never from markup a save wrote, so a style is scaled once however often a save asks, and the derived copy
// the shape writer makes of the changes belongs to that shape alone (a notes frame sharing the source style keeps
// it). A common style is styles.xml's, scaled there (scaleFontSizes); sizes `changes` already sets are the model's.
export function odpScaledTextChanges(changes: StyleChanges, deck: Deck, style: OdfStyle | undefined): void {
	const scale = textScaleOf(deck)

	if (scale === 1 || style?.automatic !== true) return

	for (const sizes of SCALED_SIZES) {
		const attributes = style.properties.get(sizes.kind)?.attributes
		const held = changes.attributes.get(sizes.kind)

		if (attributes === undefined) continue

		for (const name of sizes.names) {
			const value = held?.has(name) === true ? undefined : scaledLength(attributes.get(name), scale, sizes.range)

			if (value !== undefined) setProperty(changes, sizes.kind, name, value)
		}
	}
}

function emuOf(value: string | undefined): number | undefined {
	const points = parseLength(value)

	return points === undefined ? undefined : points * EMU_PER_PT
}

// The master page shapes the change moved, each written at its new box. A group (draw:g, §10.3.15) takes no box of
// its own: the reader makes its box its members' bounds, so its members are written through the group's mapping of
// its child space. A boxed shape takes svg:x/y/width/height (§19.540–19.574), a line its ends (§19.570–19.573). A
// shape placed by draw:transform (§19.229, its steps applied in the order written) keeps its own steps: a turn and a
// translation as LibreOffice writes them take the moved translation; any other list takes the size changes' page
// mapping after its own. What would not be written whole (a routed connector, an element without a box, a mirrored
// group) is refused when the change is sent (masterMoveRefusal), so a shape is never written half-moved.
function moveShapes(
	shapes: readonly ShapeNode[],
	fragment: Fragment,
	set: (node: number, canonical: string, value: string) => void,
	page: PageMapping,
	mapping: Affine = IDENTITY
): Refused | undefined {
	for (const shape of shapes) {
		const src = shape.src
		const xfrm = shape.xfrm

		if (xfrm === undefined || src?.format !== "odp" || src.part !== fragment.part) continue

		const unmovable = unmovableMasterShape(shape, fragment)

		if (unmovable !== undefined) return unmovable

		const name = fragment.name(src.node)
		const attributes = fragment.attributes(src.node)
		const transform = attributes.get("draw:transform")

		if (name === "draw:g") {
			const group = groupAffine(xfrm)

			if (isRefused(group)) return group

			const refusal = moveShapes(shape.children ?? [], fragment, set, page, compose(mapping, group))

			if (refusal !== undefined) return refusal

			continue
		}

		if (transform !== undefined) {
			const turned = TURNED.exec(transform)
			const tx = emuOf(turned?.[2])
			const ty = emuOf(turned?.[3])

			if (turned !== null && tx !== undefined && ty !== undefined && !attributes.has("svg:x") && !attributes.has("svg:y")) {
				const box = placed(xfrm, mapping)

				set(src.node, "svg:width", cm(box.cx))
				set(src.node, "svg:height", cm(box.cy))
				set(
					src.node,
					"draw:transform",
					`rotate (${turned[1] ?? "0"}) translate (${cm(tx * page.scale + page.dx)} ${cm(ty * page.scale + page.dy)})`
				)
			} else if (page.scale !== 1 || page.dx !== 0 || page.dy !== 0) {
				const scale = String(Number(page.scale.toFixed(12)))

				set(src.node, "draw:transform", `${transform.trim()} scale (${scale} ${scale}) translate (${cm(page.dx)} ${cm(page.dy)})`)
			}

			continue
		}

		if (LINE_ELEMENTS.has(name)) {
			const ends = lineEnds(xfrm, mapping).map(cm)
			const names = ["svg:x1", "svg:y1", "svg:x2", "svg:y2"] as const

			if (names.every((each, index) => sameLength(attributes.get(each), ends[index]))) continue

			for (const [index, each] of names.entries()) set(src.node, each, ends[index] as string)

			continue
		}

		const box = placed(xfrm, mapping)
		const wanted = [box.x, box.y, box.cx, box.cy].map(cm)
		const names = ["svg:x", "svg:y", "svg:width", "svg:height"] as const

		if (names.every((each, index) => sameLength(attributes.get(each), wanted[index]))) continue
		// A turn comes only from draw:transform (above): a box turned here has no way to be written.
		if (box.rot !== 0) return refused("unsupported", "a master page shape turned by its group, resized with the slide")

		for (const [index, each] of names.entries()) set(src.node, each, wanted[index] as string)
	}

	return undefined
}

// draw:transform as LibreOffice writes a turned box: "rotate (angle) translate (x y)".
const TURNED = /^\s*rotate\s*\(\s*([-+0-9.eE]+)\s*\)\s*translate\s*\(\s*([^\s,)]+)[\s,]+([^\s,)]+)\s*\)\s*$/u

// What keeps a master page shape from being written moved: a routed connector (its svg:d route stays where it was), an
// element that takes no box, a mirrored group.
function unmovableMasterShape(shape: ShapeNode, fragment: Fragment): Refused | undefined {
	const src = shape.src

	if (shape.xfrm === undefined || src?.format !== "odp" || src.part !== fragment.part) return undefined

	const name = fragment.name(src.node)

	if (name === "draw:g") {
		if (shape.xfrm.flipH || shape.xfrm.flipV) return refused("unsupported", "a mirrored group on a master page, resized with the slide")

		for (const child of shape.children ?? []) {
			const refusal = unmovableMasterShape(child, fragment)

			if (refusal !== undefined) return refusal
		}

		return undefined
	}

	if (LINE_ELEMENTS.has(name))
		return fragment.attributes(src.node).has("svg:d")
			? refused("unsupported", `a routed ${name} on a master page, resized with the slide`)
			: undefined

	return BOXED_ELEMENTS.test(name) ? undefined : refused("unsupported", `the box of a master page ${name}, resized with the slide`)
}

// A scaled size change that moves the content, refused when it is sent over a master page shape of styles.xml the save
// could not write moved.
export function masterMoveRefusal(deck: Deck, fragment: Fragment): Refused | undefined {
	for (const ref of deck.masters) {
		const master = deck.nodes.get(ref)

		if (master?.src?.format !== "odp" || master.src.part !== fragment.part) continue

		for (const shape of master.shapes) {
			const refusal = unmovableMasterShape(shape, fragment)

			if (refusal !== undefined) return refusal
		}
	}

	return undefined
}

// Elements whose box is svg:x/y/width/height, and lines (their ends).
const BOXED_ELEMENTS =
	/^(draw:(frame|custom-shape|rect|ellipse|circle|polygon|polyline|path|regular-polygon|caption|control|page-thumbnail)|dr3d:scene)$/u
const LINE_ELEMENTS: ReadonlySet<string> = new Set(["draw:line", "draw:connector", "draw:measure"])

// Whether a written length is `wanted` (cm, as cm() writes it) within an EMU.
function sameLength(written: string | undefined, wanted: string | undefined): boolean {
	const a = emuOf(written)
	const b = emuOf(wanted)

	return a !== undefined && b !== undefined && Math.abs(a - b) <= 1
}

// --- styles.xml: drawing resources and gallery master pages ---

// The containers of office:document-styles, in the order the schema has them (§3.15.3).
const CONTAINERS = ["office:font-face-decls", "office:styles", "office:automatic-styles", "office:master-styles"] as const

type Container = (typeof CONTAINERS)[number]

// styles.xml as a source save writes it (undefined when it stays as it was): the slide size (odpSizedStyles), the
// drawing resources the save's pages named (gradients, pictures and tiles of backgrounds), and the gallery master
// pages this session made: each one the deck has, written in the deck's master order with its font faces,
// presentation styles, automatic styles and page layout at the deck's size (written again when the size differs);
// each one it no longer has, taken out with the styles it brought. The file's own master pages are never removed.
export function odpDesignStyles(
	deck: Deck,
	fragment: Fragment | undefined,
	styles: OdpStylesApi,
	sized: boolean
): Uint8Array | Refused | undefined {
	const resources = RESOURCES.get(styles)?.elements ?? []
	const held = heldStyles(deck)

	// An undo put styles.xml back in a state the file had before a save since: written as that file had it.
	if (held !== undefined && resources.length === 0) return held

	const gallery = [...galleryDesigns(deck).entries()]

	if (!sized && resources.length === 0 && gallery.length === 0) return undefined
	if (fragment === undefined)
		return resources.length === 0 && !sized && gallery.every(([ref]) => !deck.masters.includes(ref))
			? undefined
			: refused("unsupported", "a package without styles.xml")

	const document = fragment.document
	const editor = new XmlEditor(document)
	const root = document.documentElement()
	const scope = fragment.namespaces.inScope(root)
	const containers = new Map<Container, number>()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		const name = fragment.name(child) as Container

		if (CONTAINERS.includes(name) && !containers.has(name)) containers.set(name, child)
	}

	// New children of a container, last in it (a container the file lacks is made, in its place among the others).
	const pending = new Map<Container, string>()
	const add = (container: Container, markup: string): void => {
		pending.set(container, (pending.get(container) ?? "") + markup)
	}

	if (sized) {
		const refusal = sizeEdits(deck, fragment, editor)

		if (refusal !== undefined) return refusal
	}

	for (const element of resources) add("office:styles", element)

	const galleryRefusal = galleryEdits(deck, fragment, editor, containers, add, gallery)

	if (galleryRefusal !== undefined) return galleryRefusal

	for (const [index, container] of CONTAINERS.entries()) {
		const markup = pending.get(container)

		if (markup === undefined || markup === "") continue

		const node = containers.get(container)

		if (node !== undefined) {
			editor.append(node, declaredEach(markup, scope))

			continue
		}

		const made = declared(`<${container}>${markup}</${container}>`, scope)
		const after = CONTAINERS.slice(index + 1)
			.map(name => containers.get(name))
			.find(found => found !== undefined)

		if (after === undefined) editor.append(root, made)
		else editor.insertBefore(after, made)
	}

	return editor.changed ? editor.serialize() : undefined
}

// Each top-level element of `markup` with the declarations it needs where it goes.
function declaredEach(markup: string, scope: ReadonlyMap<string, string>): string {
	if ([...Object.entries(WRITTEN_NAMESPACES)].every(([prefix, uri]) => !markup.includes(`${prefix}:`) || scope.get(prefix) === uri))
		return markup

	let out = ""
	let depth = 0
	let start = 0

	for (const match of markup.matchAll(/<(\/?)[^>]*?(\/?)>/gu)) {
		const closing = match[1] === "/"
		const empty = match[2] === "/"

		if (!closing && depth === 0) start = match.index
		if (!closing && !empty) depth++
		if (closing) depth--
		if (depth === 0) {
			out += declared(markup.slice(start, match.index + match[0].length), scope)
		}
	}

	return out
}

function galleryEdits(
	deck: Deck,
	fragment: Fragment,
	editor: XmlEditor,
	containers: ReadonlyMap<Container, number>,
	add: (container: Container, markup: string) => void,
	gallery: readonly (readonly [SlideRef, GalleryDesign])[]
): Refused | undefined {
	const document = fragment.document
	const named = (container: Container, element: string): Map<string, number> => {
		const out = new Map<string, number>()
		const node = containers.get(container)

		if (node === undefined) return out

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (fragment.name(child) !== element) continue

			const name = fragment.attributes(child).get(element === "draw:gradient" ? "draw:name" : "style:name")

			if (name !== undefined) out.set(name, child)
		}

		return out
	}
	const masters = named("office:master-styles", "style:master-page")
	const faces = named("office:font-face-decls", "style:font-face")
	const designs = new Map(gallery)
	const written = new Set<string>()
	let before = ""

	// What a gallery design brought (its styles are named by its master page name and a separator), taken out.
	const removeOwned = (name: string): void => {
		for (const container of ["office:styles", "office:automatic-styles", "office:master-styles"] as const) {
			const node = containers.get(container)

			if (node === undefined) continue

			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const attributes = fragment.attributes(child)
				const own = attributes.get("style:name") ?? attributes.get("draw:name") ?? ""

				if (own === name || own.startsWith(`${name}_`) || own.startsWith(`${name}-`)) editor.remove(child)
			}
		}
	}

	for (const ref of deck.masters) {
		const design = designs.get(ref)
		const name = design?.names.master ?? masterName(deck, ref, fragment)
		const present = name === undefined ? undefined : masters.get(name)

		if (design === undefined) {
			// The file's own master page: gallery ones missing before it go in before it.
			if (present !== undefined && before !== "") {
				editor.insertBefore(present, declaredEach(before, fragment.namespaces.inScope(document.documentElement())))
				before = ""
			}

			continue
		}

		const theme = filenTheme(design.themeId)

		if (theme === undefined) return refused("unsupported", `theme ${design.themeId}`)

		const made = odpGalleryMaster(theme, design.variant, deck.size, design.names.master, themeName(theme, design.variant))

		written.add(design.names.master)

		if (present !== undefined) {
			// Written by an earlier save: again when the deck's size changed since (its page layout and master page).
			const layoutName = fragment.attributes(present).get("style:page-layout-name")
			const layout = layoutName === undefined ? undefined : named("office:automatic-styles", "style:page-layout").get(layoutName)
			const width = layout === undefined ? undefined : pageWidth(fragment, layout)

			if (width !== themeCm(deck.size.cx) || layout === undefined || pageHeight(fragment, layout) !== themeCm(deck.size.cy)) {
				editor.replace(present, declaredEach(made.master, fragment.namespaces.inScope(present)))

				if (layout !== undefined) editor.replace(layout, declaredEach(made.pageLayout, fragment.namespaces.inScope(layout)))
				else add("office:automatic-styles", made.pageLayout)
			}

			continue
		}

		for (const [face, markup] of made.fonts) {
			if (faces.has(face)) continue

			faces.set(face, -1)
			add("office:font-face-decls", markup)
		}

		add("office:styles", made.styles)
		add("office:automatic-styles", made.automatic)
		before += made.master
	}

	if (before !== "") add("office:master-styles", before)

	// Gallery master pages an earlier save wrote that the deck no longer has.
	for (const [, design] of gallery) {
		if (written.has(design.names.master) || !masters.has(design.names.master)) continue

		removeOwned(design.names.master)
	}

	return undefined
}

// The style:name of a master the file has (its master page element), or undefined.
function masterName(deck: Deck, ref: SlideRef, fragment: Fragment): string | undefined {
	const src = deck.nodes.get(ref)?.src

	return src?.format === "odp" && src.part === fragment.part ? fragment.attributes(src.node).get("style:name") : undefined
}

function pageProperty(fragment: Fragment, layout: number, name: string): string | undefined {
	const document = fragment.document

	for (let child = document.firstChildElement(layout); child >= 0; child = document.nextSiblingElement(child))
		if (fragment.name(child) === "style:page-layout-properties") return fragment.attributes(child).get(name)

	return undefined
}

function pageWidth(fragment: Fragment, layout: number): string | undefined {
	return pageProperty(fragment, layout, "fo:page-width")
}

function pageHeight(fragment: Fragment, layout: number): string | undefined {
	return pageProperty(fragment, layout, "fo:page-height")
}
