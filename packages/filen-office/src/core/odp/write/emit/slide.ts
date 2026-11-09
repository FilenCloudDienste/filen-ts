import type { EmitPiece, EmitRequest } from "../../../pptx/write/types"
import { sameDigest } from "../../../presentation/edit/changes"
import { refused, type Deck, type Refused, type SlideNode } from "../../../presentation/model"
import { decodeUtf8, escapeAttribute } from "../../../xml/index"
import { canonicalName } from "../../../odf/index"
import type { Fragment } from "../../read/context"
import type { OdpEmitContext, OdpEmitFamily } from "../emit"
import { OdpStyles, setProperty, styleChanges } from "../styles"
import { odpGalleryMasterName } from "../../../presentation/edit/apply/design"
import { odpBackgroundStyle } from "./design"
import { IDENTITY, OdpShapeWriter, markupOf } from "./shape"
import { odpNotesMarkup } from "./notes"
import { odpNewPageAnnotations } from "./comment"
import { odpTargetIds } from "../../../anim/odf"
import { odpTransitionPar, odpTransitionSound, odpTransitionStyle, timingRootWith, withTransitionPar } from "./transition"
import { isRefused } from "../../../presentation/refusal"

// A slide as a draw:page (ODF 1.3 Part 3 §10.2.4): its name (§19.162 draw:name), master page and layout
// (§19.185 draw:master-page-name, §19.414 presentation:presentation-page-layout-name), and its drawing-page style's
// visibility and master-shape display (§19.410 presentation:visibility, §19.403
// presentation:background-objects-visible), patched on the source's start tag; a page an op made is written whole.
// Background and timing are their families' (design, timing); the transition's style properties join the page style
// and its par the timing root (emit/transition.ts).

export interface PageAspects {
	readonly name?: string
	readonly hidden?: boolean
	readonly showMasterShapes?: boolean
	readonly layout?: boolean
	readonly background?: boolean
	readonly transition?: boolean
	readonly timing?: boolean
	// A new page's header and footer display flags (written whole only).
	readonly headerFooter?: boolean
}

export function pageAspects(node: SlideNode, pristine: SlideNode | undefined, name: string): PageAspects {
	const out: { -readonly [K in keyof PageAspects]: PageAspects[K] } = {}

	if (pristine === undefined || name !== pristine.name) out.name = name
	if (pristine === undefined || node.hidden !== pristine.hidden) out.hidden = node.hidden
	if (pristine === undefined || node.showMasterShapes !== pristine.showMasterShapes) out.showMasterShapes = node.showMasterShapes
	if (pristine !== undefined && node.parent !== pristine.parent) out.layout = true
	if (pristine !== undefined && !sameDigest(node.background, pristine.background)) out.background = true
	if (pristine !== undefined && !sameDigest(node.transition, pristine.transition)) out.transition = true
	if (pristine !== undefined && !sameDigest(node.timing, pristine.timing)) out.timing = true

	return out
}

// The style:name of the master page a slide's layout belongs to (a master node is its style:master-page element).
function masterPageName(deck: Deck, node: SlideNode, styles: OdpStyles): string | undefined {
	const layout = node.parent === undefined ? undefined : deck.nodes.get(node.parent)
	const masterRef = layout?.kind === "master" ? layout.ref : layout?.parent
	const master = masterRef === undefined ? undefined : deck.nodes.get(masterRef)
	const src = master?.src
	const stylesFragment = styles.env.stylesFragment

	// A master not parsed yet: the reader lists masters in the order styles.xml holds their master pages.
	if (master === undefined) return masterRef === undefined ? undefined : styles.sheet.masterOrder[deck.masters.indexOf(masterRef)]

	// A gallery master this session made: the name odpDesignStyles writes its master page under.
	const gallery = odpGalleryMasterName(deck, master.ref)

	if (gallery !== undefined) return gallery
	if (src?.format !== "odp" || stylesFragment === undefined || src.part !== stylesFragment.part) return master.name

	return stylesFragment.attributes(src.node).get("style:name") ?? master.name
}

function layoutName(deck: Deck, node: SlideNode): string | undefined {
	const layout = node.parent === undefined ? undefined : deck.nodes.get(node.parent)

	// The page layout's style:name (layoutType); the node's name is for display.
	return layout?.kind === "layout" ? layout.layoutType : undefined
}

// A page's presentation:visibility (§19.410, visible by default): as the file first wrote it when the page is back to
// what the file had (kept for the session from the first save that changed it), else "hidden", or none for a page
// shown again unless the style it inherits from hides.
function visibility(styles: OdpStyles, base: string | undefined, node: SlideNode): string | null {
	const own = base === undefined ? undefined : styles.style("drawing-page", base)
	const values = styles.env.mirrorValues
	const key = `${String(node.ref)}\u0000presentation:visibility`
	const current = own?.properties.get("drawing-page")?.attributes.get("presentation:visibility")

	if (values !== undefined && !values.has(key)) values.set(key, current)

	const original = values === undefined ? current : values.get(key)

	if (node.hidden === (original === "hidden")) return original ?? null
	if (node.hidden) return "hidden"

	const parent = own?.automatic === true && own.parent !== undefined ? styles.style("drawing-page", own.parent) : undefined

	return parent?.properties.get("drawing-page")?.attributes.get("presentation:visibility") === "hidden" ? "visible" : null
}

// The page's drawing-page style with its visibility and master-shape display as the slide has them.
function pageStyle(
	context: OdpEmitContext,
	base: string | undefined,
	aspects: PageAspects,
	node: SlideNode,
	sound: string | undefined
): string | undefined | Refused {
	const styles = context.styles as OdpStyles
	const changes = styleChanges()

	if (aspects.hidden !== undefined) setProperty(changes, "drawing-page", "presentation:visibility", visibility(styles, base, node))
	if (aspects.showMasterShapes !== undefined)
		setProperty(changes, "drawing-page", "presentation:background-objects-visible", node.showMasterShapes ? "true" : "false")
	if (aspects.transition === true) odpTransitionStyle(changes, node.transition, sound)

	// A new page's header and footer display flags (§20.233–§20.236), as the page it took them from has them.
	let display = false

	if (aspects.headerFooter === true)
		for (const [kind, shown] of Object.entries(node.odpHeaderFooter?.display ?? {})) {
			setProperty(changes, "drawing-page", `presentation:display-${kind}`, String(shown))
			display = true
		}

	if (aspects.background === true) {
		const refusal = odpBackgroundStyle(changes, node.background, context)

		if (refusal !== undefined) return refusal
	}

	if (changes.attributes.size === 0) return undefined
	if (
		base === undefined &&
		!node.hidden &&
		node.showMasterShapes &&
		node.transition === undefined &&
		node.background === undefined &&
		!display
	)
		return undefined

	return styles.derived("drawing-page", base, changes)
}

// The changed attributes of a page's start tag (canonical names), or a refusal for a part another family writes.
export function pageChanges(
	deck: Deck,
	node: SlideNode,
	aspects: PageAspects,
	attributes: ReadonlyMap<string, string>,
	context: OdpEmitContext
): Map<string, string | null> | Refused {
	const styles = context.styles as OdpStyles
	const out = new Map<string, string | null>()

	// Timing is the page's anim:par element, not an attribute: the splice puts the timing family's element in place.

	if (aspects.name !== undefined) out.set("draw:name", aspects.name)

	const sound = aspects.transition === true ? odpTransitionSound(node.transition, context) : undefined

	if (isRefused(sound)) return sound

	const style = pageStyle(context, attributes.get("draw:style-name"), aspects, node, sound)

	if (isRefused(style)) return style
	if (style !== undefined) out.set("draw:style-name", style)

	if (aspects.layout === true) {
		const master = masterPageName(deck, node, styles)
		const layout = layoutName(deck, node)

		if (master === undefined) return refused("notFound", "the master page of the slide's layout")

		out.set("draw:master-page-name", master)
		out.set("presentation:presentation-page-layout-name", layout ?? null)
	}

	return out
}

// A new page's presentation:use-header-name, use-footer-name and use-date-time-name: the declarations of content.xml
// the page it took its header and footer from names (kept by the splice with the rest of office:presentation).
function useNames(node: SlideNode): string {
	let out = ""

	for (const [kind, name] of Object.entries(node.odpHeaderFooter?.use ?? {}))
		out += ` presentation:use-${kind}-name="${escapeAttribute(name)}"`

	return out
}

// A page an op made, written whole: its start tag and its shapes. `newId`: an id no element of the content holds
// (the page's, when its transition par begins by it).
// `newId(base)`: an id no element of the document holds, `base` itself when it is free.
export function newPage(
	deck: Deck,
	node: SlideNode,
	name: string,
	given: OdpEmitContext,
	newId?: (base?: string) => string
): string | Refused {
	// The shapes the page's timing targets are named by ids unique in the document (ODF 1.3 Part 1 §19.914 xml:id), as
	// the shapes and the timing are written.
	const targetIds = new Map<number, string>()

	if (newId !== undefined) for (const id of odpTargetIds(node.timing)) targetIds.set(id, newId(`id${String(id)}`))

	const context: OdpEmitContext = targetIds.size === 0 ? given : { ...given, targetIds }
	const styles = context.styles as OdpStyles
	// A page names a master page (§19.185 draw:master-page-name is required): its layout's, else the deck's first.
	const master = masterPageName(deck, node, styles) ?? styles.sheet.masterOrder[0]
	const layout = layoutName(deck, node)
	const sound = odpTransitionSound(node.transition, context)

	if (isRefused(sound)) return sound

	const style = pageStyle(
		context,
		undefined,
		{
			hidden: node.hidden,
			showMasterShapes: node.showMasterShapes,
			...(node.transition === undefined ? {} : { transition: true }),
			...(node.background === undefined ? {} : { background: true }),
			...(node.odpHeaderFooter === undefined ? {} : { headerFooter: true })
		},
		node,
		sound
	)

	if (isRefused(style)) return style

	const needsPar = odpTransitionPar(node.transition, "") !== undefined

	if (needsPar && newId === undefined) return refused("failed", "an id for the page's transition")

	const id = needsPar ? newId?.() : undefined
	const par = id === undefined ? undefined : odpTransitionPar(node.transition, id, sound)

	const writer = new OdpShapeWriter(context, undefined, node, () => undefined)
	let shapes = ""

	for (const shape of node.shapes) {
		const pieces = writer.element(shape, IDENTITY)

		if (isRefused(pieces)) return pieces

		const markup = markupOf({ kind: "markup", pieces })

		if (isRefused(markup)) return markup

		shapes += markup
	}

	let notes = ""
	const notesNode = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

	if (notesNode !== undefined && notesNode.src === undefined) {
		const made = odpNotesMarkup(node, notesNode, deck.slides.indexOf(node.ref) + 1, given)

		if (isRefused(made)) return made

		notes = made
	} else if (notesNode !== undefined && notesNode.shapes.length > 0) {
		const notesWriter = new OdpShapeWriter(given, undefined, notesNode, () => undefined)

		for (const shape of notesNode.shapes) {
			const pieces = notesWriter.element(shape, IDENTITY)

			if (isRefused(pieces)) return pieces

			const markup = markupOf({ kind: "markup", pieces })

			if (isRefused(markup)) return markup

			notes += markup
		}

		notes = `<presentation:notes>${notes}</presentation:notes>`
	}

	const attributes =
		` draw:name="${escapeAttribute(name)}"` +
		(style === undefined ? "" : ` draw:style-name="${escapeAttribute(style)}"`) +
		(master === undefined ? "" : ` draw:master-page-name="${escapeAttribute(master)}"`) +
		(layout === undefined || layout === "" ? "" : ` presentation:presentation-page-layout-name="${escapeAttribute(layout)}"`) +
		useNames(node) +
		(id === undefined ? "" : ` xml:id="${escapeAttribute(id)}" draw:id="${escapeAttribute(id)}"`)

	const own = timingMarkup(node, context)

	if (isRefused(own)) return own

	const timing = par === undefined ? own : own === "" ? timingRootWith(par) : withTransitionPar([own], undefined, -1, par)?.join("")

	if (timing === undefined) return refused("failed", "the page's timing root")

	return `<draw:page${attributes}>${shapes}${timing}${notes}${odpNewPageAnnotations(deck, node, new Map())}</draw:page>`
}

// A page's timing root as the timing family writes it (§19.4 anim:par timing-root, after the shapes and before the
// notes, ODF 1.3 RNG draw-page): pieces with spans of the page fragment, or none when the slide has no timing.
export function timingPieces(node: SlideNode, context: OdpEmitContext): EmitPiece[] | Refused {
	const request: EmitRequest = { slide: node, touch: { kind: "slide", slide: node.ref, dirt: { kind: "slidePart", part: "timing" } } }
	const result = (context.styles as OdpStyles).env.dispatch("timing", request, context)

	if (result.kind === "refused") return result
	if (result.kind === "unchanged") return []

	return [...result.pieces]
}

function timingMarkup(node: SlideNode, context: OdpEmitContext): string | Refused {
	if (node.timing === undefined) return ""

	const pieces = timingPieces(node, context)

	return isRefused(pieces) ? pieces : markupOf({ kind: "markup", pieces })
}

// The slide family: a page an op made (whole), or a source page's start tag with its changed attributes.
export const emitOdpSlide: OdpEmitFamily = {
	emit(request, context) {
		if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

		const node = request.slide
		const name = context.styles.env.pageName(node.ref) ?? node.name ?? ""

		if (node.src === undefined || context.document === undefined) {
			const markup = newPage(context.deck, node, name, context)

			return isRefused(markup) ? markup : { kind: "markup", pieces: [markup] }
		}

		const fragment = context.styles.env.fragmentOf(context.document)

		if (fragment === undefined || node.src.format !== "odp") return refused("failed", "the page's source")

		const changes = pageChanges(context.deck, node, pageAspects(node, undefined, name), fragment.attributes(node.src.node), context)

		if (isRefused(changes)) return changes

		const pieces: EmitPiece[] = [startTag(fragment, node.src.node, changes)]

		return { kind: "markup", pieces }
	}
}

// A start tag with attribute changes (canonical names written with the element's own prefixes).
export function startTag(fragment: Fragment, node: number, changes: ReadonlyMap<string, string | null>, selfClose = false): string {
	const document = fragment.document
	const pending = new Map(changes)
	// Each attribute as the source spells it (its quotes and character references), for those written unchanged.
	const spans = document.attributeSpans(node).slice()
	const asWritten = (k: number): string => {
		const valueStart = spans[k * 4 + 2] ?? 0
		const quote = String.fromCharCode(document.bytes[valueStart - 1] ?? 0x22)

		return `${decodeUtf8(document.bytes, spans[k * 4] ?? 0, spans[k * 4 + 1] ?? 0)}=${quote}${decodeUtf8(document.bytes, valueStart, spans[k * 4 + 3] ?? 0)}${quote}`
	}
	let out = `<${document.name(node)}`

	for (const [k, attribute] of document.attributes(node).entries()) {
		if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) {
			out += ` ${asWritten(k)}`

			continue
		}

		const canonical = canonicalOf(fragment, node, attribute.name)

		if (pending.has(canonical)) {
			const value = pending.get(canonical)

			pending.delete(canonical)

			if (value === attribute.value) out += ` ${asWritten(k)}`
			else if (value !== null && value !== undefined) out += ` ${attribute.name}="${escapeAttribute(value)}"`

			continue
		}

		out += ` ${asWritten(k)}`
	}

	for (const [name, value] of pending) if (value !== null) out += ` ${name}="${escapeAttribute(value)}"`

	return `${out}${selfClose ? "/>" : ">"}`
}

// An attribute's canonical name ("draw:name") as the reader names it.
export function canonicalOf(fragment: Fragment, node: number, name: string): string {
	const colon = name.indexOf(":")

	if (colon < 0) return name

	const prefix = name.slice(0, colon)

	if (prefix === "xml") return name

	return canonicalName(fragment.namespaces.uri(node, prefix), name.slice(colon + 1))
}
