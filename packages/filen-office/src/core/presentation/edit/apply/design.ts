import { filenTheme } from "../../../templates/themes/catalog"
import { parseThemeName, themeName } from "../../../templates/themes/model"
import { odpGalleryMaster } from "../../../templates/themes/odp"
import { LAYOUT_TYPES, designSet, type FilenLayoutType } from "../../../templates/themes/pptx"
import { encodeUtf8 } from "../../../xml/index"
import { DEFAULT_CLR_MAP } from "../../theme"
import { refused, type Background, type Deck, type Refused, type ShapeNode, type SlideNode, type SlideRef, type Xfrm } from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import type { DesignThemeInfo, PresentationDesignInfo } from "../commands/design"
import type { DeckOp, DesignOp, InsertedImage } from "../ops"
import { ContentScaler, holdsLock } from "./designScale"
import { onHeldPage, pageMarkup, sourceReading } from "./heldPage"
import { registerInsertedImage } from "./picture"

// The design family: the deck's theme (a Filen gallery theme, or a master the file has), its colour variant, the
// slide size, and slide backgrounds.
//
// A gallery theme is applied as PowerPoint applies a theme: a new master with its eleven layouts and its theme part
// (core/templates/themes, generated at the deck's size), and each slide moved onto the new layout of its layout's
// type. A slide's own markup is not touched: only its relationship to its layout changes, and its placeholders
// inherit by type and idx. A master the file had when it was opened is kept when no slide uses it any more (it stays
// one of the file's own themes); a gallery master this session added is dropped from the deck once unused, since it
// can be made again byte for byte. A variant is the same theme in another colour variant, applied the same way. In
// ODP a theme is a master page: the file's own are applied by reassigning the pages' master.
//
// The session holds what a gallery theme generates under its part names (DesignReading, the engine's half), so the
// renderer and the writer resolve the new nodes like package parts; the save writes them (pptx emit/design.ts).
// Theme ops need every slide parsed: the engine parses them before the op applies.

export type DesignPartKind = "theme" | "slideMaster" | "slideLayout"

export interface DesignHeldPart {
	readonly name: string
	readonly kind: DesignPartKind
	readonly bytes: Uint8Array
	// Its relationships part, for a master or a layout.
	readonly rels?: Uint8Array
}

// The engine's half: generated parts held in the session, and free names for them.
export interface DesignReading {
	// Holds `part` under its name, so documents, themes and source refs into it resolve like a package part's; a
	// master or layout is read into a node with `ref` (its parent and theme are the caller's to set). Holding a name
	// again replaces what was held (a part made again).
	holdDesign(part: DesignHeldPart, ref?: SlideRef): SlideNode | undefined | Refused
	// A part name of the kind unused in the package and the session ("/ppt/slideMasters/slideMaster3.xml").
	newDesignPart(kind: DesignPartKind): string
	// ODP: the source's styles.xml as the file has it (undefined: the package has none).
	stylesBytes?(): Uint8Array | undefined
	// ODP: why a size change that moves the content could not write a master page shape of styles.xml moved.
	masterMoveRefusal?(deck: Deck): Refused | undefined
}

// ODP: a design op that puts something in styles.xml (a gallery master page, the page layouts' size, a drawing
// resource) refused on a package without one (ODF 1.3 Part 2 §3.1), when it is sent rather than by the save.
function withoutStyles(deck: Deck, context: ApplyContext): Refused | undefined {
	const reading = deck.format === "odp" ? designReadingOf(context) : undefined

	return reading?.stylesBytes !== undefined && reading.stylesBytes() === undefined
		? refused("unsupported", "a package without styles.xml")
		: undefined
}

export function designReadingOf(context: ApplyContext): DesignReading | undefined {
	const candidate = context as ApplyContext & Partial<DesignReading>

	return typeof candidate.holdDesign === "function" && typeof candidate.newDesignPart === "function"
		? (candidate as ApplyContext & DesignReading)
		: undefined
}

// A gallery master this session made: what makes its parts again.
export interface GalleryDesign {
	readonly themeId: string
	readonly variant: number
	// Model part names ("/ppt/theme/theme2.xml"). ODP: `master` is the master page's style:name, `theme` is empty and
	// `layouts` are the presentation page layouts (layoutType) of the layouts synthesized for it.
	readonly names: { readonly theme: string; readonly master: string; readonly layouts: readonly string[] }
	readonly master: SlideRef
	readonly layouts: readonly SlideRef[]
}

const GALLERY = new WeakMap<Deck, Map<SlideRef, GalleryDesign>>()

function galleryOf(deck: Deck): Map<SlideRef, GalleryDesign> {
	let map = GALLERY.get(deck)

	if (map === undefined) {
		map = new Map()
		GALLERY.set(deck, map)
	}

	return map
}

// The gallery masters this session made, by master ref (the writer makes their parts at the deck's size).
export function galleryDesigns(deck: Deck): ReadonlyMap<SlideRef, GalleryDesign> {
	return GALLERY.get(deck) ?? new Map<SlideRef, GalleryDesign>()
}

// ODP: the master page name a gallery master this session made is written under.
export function odpGalleryMasterName(deck: Deck, master: SlideRef): string | undefined {
	return deck.format === "odp" ? GALLERY.get(deck)?.get(master)?.names.master : undefined
}

// The Filen theme and variant a master shows, when it is one of ours (made here, or read from its name).
export function masterGalleryTheme(deck: Deck, master: SlideNode): { readonly id: string; readonly variant: number } | undefined {
	const made = GALLERY.get(deck)?.get(master.ref)

	if (made !== undefined) return { id: made.themeId, variant: made.variant }

	const named = parseThemeName(master.name)

	return named !== undefined && filenTheme(named.id) !== undefined ? named : undefined
}

// The design state an inverse puts back, kept by op identity (history keeps its ops).
interface DesignState {
	readonly masters: readonly SlideRef[]
	readonly layouts: readonly SlideRef[]
	readonly parents: readonly (readonly [SlideRef, SlideRef])[]
}

const PRIOR = new WeakMap<DesignOp, DesignState>()
// The gallery design an op as applied made: a redo makes the same one (its refs and part names), so later ops in
// history still name what it made.
const MADE = new WeakMap<DesignOp, GalleryDesign>()
const TOUCHES = new WeakMap<DesignOp, readonly Touch[]>()

// Backgrounds restored from the source's bytes (an undo back to the file's own p:bg): emit/design.ts writes them.
const BACKGROUND_RAWS = new WeakMap<Background, Uint8Array>()

export function backgroundRaw(background: Background): Uint8Array | undefined {
	return BACKGROUND_RAWS.get(background)
}

// ST_SlideLayoutType values (§19.7.15) outside our eleven, to the nearest of them.
const NEAREST_LAYOUT: Readonly<Record<string, FilenLayoutType>> = {
	tx: "obj",
	twoColTx: "twoObj",
	tbl: "obj",
	txAndChart: "twoObj",
	chartAndTx: "twoObj",
	dgm: "obj",
	chart: "obj",
	txAndClipArt: "twoObj",
	clipArtAndTx: "twoObj",
	txAndObj: "twoObj",
	objAndTx: "twoObj",
	objOnly: "obj",
	txAndMedia: "twoObj",
	mediaAndTx: "twoObj",
	objOverTx: "obj",
	txOverObj: "obj",
	txAndTwoObj: "twoTxTwoObj",
	twoObjAndTx: "twoTxTwoObj",
	twoObjOverTx: "twoObj",
	fourObj: "twoObj",
	clipArtAndVertTx: "vertTx",
	vertTitleAndTxOverChart: "vertTitleAndTx",
	twoObjAndObj: "twoObj",
	objAndTwoObj: "twoObj"
}

// The layout type a slide takes on a new theme: its layout's own, the nearest of ours, else by what its layout holds.
export function targetLayoutType(layout: SlideNode | undefined): FilenLayoutType {
	const type = layout?.layoutType

	if (type !== undefined && (LAYOUT_TYPES as readonly string[]).includes(type)) return type as FilenLayoutType

	const nearest = type === undefined ? undefined : NEAREST_LAYOUT[type]

	if (nearest !== undefined) return nearest

	const placeholders = (layout?.shapes ?? []).flatMap(shape => (shape.ph === undefined ? [] : [shape.ph]))
	const types = new Set(placeholders.map(ph => ph.type))

	if (types.has("ctrTitle") || types.has("subTitle")) return "title"

	const title = types.has("title")
	const body = types.has("body") || types.has("obj") || placeholders.some(ph => ph.idx === 1)

	if (title && body) return "obj"
	if (title) return "titleOnly"

	return "blank"
}

function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refused"
}

function slidesOf(deck: Deck, refs: readonly SlideRef[]): SlideNode[] | Refused {
	const out: SlideNode[] = []

	for (const ref of refs) {
		if (!deck.slides.includes(ref)) return refused("notFound", `slide ${String(ref)}`)

		const node = deck.nodes.get(ref)

		if (node?.kind !== "slide") return refused("notFound", `slide ${String(ref)} is not parsed`)

		out.push(node)
	}

	return out
}

function stateOf(deck: Deck): DesignState {
	const parents: [SlideRef, SlideRef][] = []

	for (const ref of deck.slides) {
		const parent = deck.nodes.get(ref)?.parent

		if (parent !== undefined) parents.push([ref, parent])
	}

	return { masters: [...deck.masters], layouts: [...deck.layouts], parents }
}

export function masterOfSlide(deck: Deck, slide: SlideNode): SlideRef | undefined {
	const layout = slide.parent === undefined ? undefined : deck.nodes.get(slide.parent)

	return layout?.kind === "master" ? layout.ref : layout?.parent
}

// The last revision of each gallery node the deck dropped: one made again continues from it (render memo keys).
const DROPPED = new WeakMap<Deck, Map<SlideRef, number>>()

// Masters this session made that no slide uses any more leave the deck with their layouts (an undo makes them again,
// byte for byte, from their GalleryDesign).
function dropUnusedGallery(deck: Deck): void {
	const gallery = GALLERY.get(deck)

	if (gallery === undefined) return

	const used = new Set<SlideRef>()

	for (const ref of deck.slides) {
		const node = deck.nodes.get(ref)
		const master = node === undefined ? undefined : masterOfSlide(deck, node)

		if (master !== undefined) used.add(master)
	}

	for (const [ref, design] of gallery) {
		if (used.has(ref) || !deck.masters.includes(ref)) continue

		const layouts = new Set(design.layouts)

		// ODP: layouts synthesized for the master later (a slide moved onto it as the file's own theme) go with it.
		for (const layout of deck.layouts) if (deck.nodes.get(layout)?.parent === ref) layouts.add(layout)

		forgetGallery(deck, design)
		deck.masters = deck.masters.filter(master => master !== ref)
		deck.layouts = deck.layouts.filter(layout => !layouts.has(layout))
	}
}

// A gallery master's nodes out of the deck's table (its last revisions kept).
function forgetGallery(deck: Deck, design: GalleryDesign): void {
	let revisions = DROPPED.get(deck)

	if (revisions === undefined) {
		revisions = new Map()
		DROPPED.set(deck, revisions)
	}

	for (const ref of [design.master, ...design.layouts]) {
		const node = deck.nodes.get(ref)

		if (node === undefined) continue

		revisions.set(ref, node.revision)
		deck.nodes.delete(ref)
	}
}

function nextRevision(deck: Deck, ref: SlideRef): number {
	const held = deck.nodes.get(ref)?.revision ?? DROPPED.get(deck)?.get(ref)

	return held === undefined ? 0 : held + 1
}

function slideTouch(slide: SlideRef, dirt: Extract<Touch, { kind: "slide" }>["dirt"]): Touch {
	return { kind: "slide", slide, dirt }
}

// What a theme change touches: every slide (drawn again on its new layout) and every master and layout it adds or
// drops (their nodes).
function themeTouches(before: DesignState, after: DesignState): Touch[] {
	// A slide's node: its layout is part of it (the writer retargets only the relationship when nothing else of the
	// slide changed).
	const out: Touch[] = after.parents.map(([slide]) => slideTouch(slide, { kind: "node" }))
	const missing = (a: readonly SlideRef[], b: readonly SlideRef[]): SlideRef[] => {
		const set = new Set(b)

		return a.filter(ref => !set.has(ref))
	}

	for (const ref of [
		...missing(after.masters, before.masters),
		...missing(before.masters, after.masters),
		...missing(after.layouts, before.layouts),
		...missing(before.layouts, after.layouts)
	])
		out.push(slideTouch(ref, { kind: "node" }))

	return out
}

// The parts of a gallery design made at the deck's size and held; with `again`, onto its existing nodes.
function holdGallery(deck: Deck, design: GalleryDesign, reading: DesignReading, again: boolean): Refused | undefined {
	const theme = filenTheme(design.themeId)

	if (theme === undefined) return refused("unsupported", `theme ${design.themeId}`)
	if (deck.format === "odp") return holdOdpGallery(deck, design, reading, again)

	const zip = (name: string): string => (name.startsWith("/") ? name.slice(1) : name)
	// Ids are the writer's to choose (unique in the package it writes); the held markup's are placeholders.
	const set = designSet(
		theme,
		design.variant,
		deck.size,
		{ theme: zip(design.names.theme), master: zip(design.names.master), layouts: design.names.layouts.map(zip) },
		2_147_483_648
	)
	const themeHeld = reading.holdDesign({ name: design.names.theme, kind: "theme", bytes: encodeUtf8(set.theme.markup) })

	if (isRefused(themeHeld)) return themeHeld

	const masterRevision = again ? nextRevision(deck, design.master) : 0
	const themeRevision = (deck.nodes.get(design.master)?.theme?.revision ?? -1) + 1
	const master = reading.holdDesign(
		{ name: design.names.master, kind: "slideMaster", bytes: encodeUtf8(set.master.markup), rels: encodeUtf8(set.master.rels ?? "") },
		design.master
	)

	if (master === undefined || isRefused(master)) return master ?? refused("failed", "the theme's master was not read")

	master.theme = { part: design.names.theme, revision: themeRevision }
	master.revision = masterRevision
	deck.nodes.set(design.master, master)

	for (const [index, layoutSet] of set.layouts.entries()) {
		const ref = design.layouts[index]
		const name = design.names.layouts[index]

		if (ref === undefined || name === undefined) return refused("failed", "a theme layout without a ref")

		const revision = again ? nextRevision(deck, ref) : 0
		const layout = reading.holdDesign(
			{ name, kind: "slideLayout", bytes: encodeUtf8(layoutSet.markup), rels: encodeUtf8(layoutSet.rels ?? "") },
			ref
		)

		if (layout === undefined || isRefused(layout)) return layout ?? refused("failed", "a theme layout was not read")

		layout.parent = design.master
		layout.layoutType ??= layoutSet.type
		layout.revision = revision
		deck.nodes.set(ref, layout)
	}

	return undefined
}

// ODP: the gallery master page (themes/odp.ts odpGalleryMaster at the deck's size) held as a styles document of its
// own and read into the master's node; its layouts synthesized as the reader synthesizes them, one per presentation
// page layout, with the placeholders of a layout of the same page layout the deck has.
function holdOdpGallery(deck: Deck, design: GalleryDesign, reading: DesignReading, again: boolean): Refused | undefined {
	const theme = filenTheme(design.themeId)

	if (theme === undefined) return refused("unsupported", `theme ${design.themeId}`)

	const generated = odpGalleryMaster(theme, design.variant, deck.size, design.names.master, themeName(theme, design.variant))
	const masterRevision = again ? nextRevision(deck, design.master) : 0
	const master = reading.holdDesign(
		{ name: design.names.master, kind: "slideMaster", bytes: encodeUtf8(generated.document) },
		design.master
	)

	if (master === undefined || isRefused(master)) return master ?? refused("failed", "the theme's master page was not read")

	master.revision = masterRevision
	deck.nodes.set(design.master, master)

	for (const [index, ref] of design.layouts.entries()) {
		const type = design.names.layouts[index] ?? ""
		const held = deck.nodes.get(ref)
		const like = deck.layouts
			.map(each => deck.nodes.get(each))
			.find(node => node !== undefined && node.ref !== ref && node.layoutType === type && node.parent !== design.master)
		const layout: SlideNode = {
			ref,
			kind: "layout",
			part: master.part,
			synthetic: true,
			...(like?.name === undefined ? {} : { name: like.name }),
			...(type === "" ? {} : { layoutType: type }),
			parent: design.master,
			showMasterShapes: true,
			hidden: false,
			shapes: (like?.shapes ?? held?.shapes ?? []).map(shape => ({ ...shape })),
			comments: [],
			revision: again ? nextRevision(deck, ref) : 0
		}

		deck.nodes.set(ref, layout)
	}

	return undefined
}

// Back to a state an op recorded: a gallery master coming back after a save removed its parts has them made again
// (the same bytes, so its nodes' source refs stand).
function restore(deck: Deck, state: DesignState, reading: DesignReading | undefined): Refused | undefined {
	for (const ref of state.masters) {
		const design = GALLERY.get(deck)?.get(ref)

		if (design === undefined || (deck.masters.includes(ref) && deck.nodes.has(ref))) continue
		if (reading === undefined) return refused("notImplemented", "design parts in this session")

		const held = holdGallery(deck, design, reading, true)

		if (held !== undefined) return held
	}

	deck.masters = [...state.masters]
	deck.layouts = [...state.layouts]

	for (const design of GALLERY.get(deck)?.values() ?? []) if (!deck.masters.includes(design.master)) forgetGallery(deck, design)

	for (const [slide, parent] of state.parents) {
		const node = deck.nodes.get(slide)

		if (node !== undefined && node.parent !== parent) {
			node.parent = parent
			node.revision++
		}
	}

	return undefined
}

function themeApplied<O extends DesignOp>(deck: Deck, op: O, before: DesignState): ApplyResult<O> {
	const after = stateOf(deck)
	const touches = themeTouches(before, after)
	const slides = after.parents.map(([slide]) => slide)
	const inverse: DesignOp = { family: "design", kind: "setTheme", theme: { kind: "deck", part: "" }, slides }

	PRIOR.set(inverse, before)
	TOUCHES.set(op, touches)
	TOUCHES.set(inverse, touches)
	deck.revision++

	return { kind: "applied", inverse: { ops: [inverse], bytes: 64 + 16 * before.parents.length }, op }
}

// Every slide parsed (a theme op moves every slide it names, and judges which masters stay by all of them).
function allParsed(deck: Deck): Refused | undefined {
	for (const ref of deck.slides)
		if (deck.nodes.get(ref)?.kind !== "slide") return refused("notFound", `slide ${String(ref)} is not parsed`)

	return undefined
}

// --- setTheme / setVariant ---

type SetTheme = Extract<DesignOp, { kind: "setTheme" }>

function applyGallery(
	deck: Deck,
	op: SetTheme,
	themeId: string,
	variant: number,
	context: ApplyContext,
	reuse: GalleryDesign | undefined
): ApplyResult<SetTheme> {
	if (deck.format !== "pptx" && deck.format !== "odp") return refused("unsupported", "a gallery theme in this format")

	const reading = designReadingOf(context)

	if (reading === undefined) return refused("notImplemented", "design parts in this session")

	const stylesless = withoutStyles(deck, context)

	if (stylesless !== undefined) return stylesless
	if (filenTheme(themeId) === undefined) return refused("notFound", `theme ${themeId}`)
	if (!Number.isInteger(variant) || variant < 0 || variant > 3) return refused("malformed", "theme variant")

	const unparsed = allParsed(deck)

	if (unparsed !== undefined) return unparsed

	const slides = slidesOf(deck, op.slides ?? deck.slides)

	if (isRefused(slides)) return slides

	const before = stateOf(deck)
	const design: GalleryDesign =
		reuse ??
		(deck.format === "odp"
			? odpDesign(deck, slides, themeId, variant, reading, context)
			: {
					themeId,
					variant,
					names: {
						theme: reading.newDesignPart("theme"),
						master: reading.newDesignPart("slideMaster"),
						layouts: LAYOUT_TYPES.map(() => reading.newDesignPart("slideLayout"))
					},
					master: context.newSlideRef(),
					layouts: LAYOUT_TYPES.map(() => context.newSlideRef())
				})
	const held = holdGallery(deck, design, reading, reuse !== undefined)

	if (held !== undefined) return held

	galleryOf(deck).set(design.master, design)
	deck.masters = [...deck.masters, design.master]
	deck.layouts = [...deck.layouts, ...design.layouts]

	// pptx: by the layout type the slide's layout is nearest; ODP: by its presentation page layout.
	const byType = new Map<string, SlideRef>(
		deck.format === "odp"
			? design.names.layouts.map((type, index) => [type, design.layouts[index] as SlideRef])
			: LAYOUT_TYPES.map((type, index) => [type, design.layouts[index] as SlideRef])
	)

	for (const slide of slides) {
		const current = slide.parent === undefined ? undefined : deck.nodes.get(slide.parent)
		const target = byType.get(deck.format === "odp" ? (current?.layoutType ?? "") : targetLayoutType(current))

		if (target === undefined) continue

		slide.parent = target
		slide.revision++
	}

	dropUnusedGallery(deck)

	const applied = themeApplied(deck, { ...op, slides: slides.map(slide => slide.ref) }, before)

	if (applied.kind === "applied") MADE.set(applied.op, design)

	return applied
}

// ODP: a gallery design's master page name and one layout per presentation page layout the moved slides have.
function odpDesign(
	deck: Deck,
	slides: readonly SlideNode[],
	themeId: string,
	variant: number,
	reading: DesignReading,
	context: ApplyContext
): GalleryDesign {
	const types: string[] = []

	for (const slide of slides) {
		const type = (slide.parent === undefined ? undefined : deck.nodes.get(slide.parent))?.layoutType ?? ""

		if (!types.includes(type)) types.push(type)
	}

	return {
		themeId,
		variant,
		names: { theme: "", master: reading.newDesignPart("slideMaster"), layouts: types },
		master: context.newSlideRef(),
		layouts: types.map(() => context.newSlideRef())
	}
}

// How a ThemeChoice of kind "deck" names a master: its part (pptx), or "/styles.xml#" and its name (ODP, where every
// master page lives in styles.xml).
export function deckThemeKey(master: SlideNode): string {
	return master.part === "/styles.xml" ? `${master.part}#${master.name ?? ""}` : master.part
}

// ODP: a layout of `master` for the presentation page layout the slide had, made as the reader makes them (layouts
// are synthesized per master and page layout, never written).
function synthesizedLayout(deck: Deck, master: SlideNode, current: SlideNode, ref: SlideRef): SlideNode {
	const layout: SlideNode = {
		ref,
		kind: "layout",
		part: master.part,
		synthetic: true,
		...(current.name === undefined ? {} : { name: current.name }),
		...(current.layoutType === undefined ? {} : { layoutType: current.layoutType }),
		parent: master.ref,
		showMasterShapes: true,
		hidden: false,
		shapes: current.shapes.map(shape => ({ ...shape })),
		comments: [],
		revision: 0
	}
	const at = deck.layouts.findLastIndex(each => deck.nodes.get(each)?.parent === master.ref)

	deck.nodes.set(ref, layout)
	deck.layouts = at < 0 ? [...deck.layouts, ref] : [...deck.layouts.slice(0, at + 1), ref, ...deck.layouts.slice(at + 1)]

	return layout
}

// The file's own theme: the slides onto the master `key` names, each on its layout of the same type (else the
// nearest, else, in ODP, one made for its page layout, else the master's first).
function applyDeckTheme(deck: Deck, op: SetTheme, key: string, context: ApplyContext): ApplyResult<SetTheme> {
	const master = deck.masters.map(ref => deck.nodes.get(ref)).find(node => node !== undefined && deckThemeKey(node) === key)

	if (master === undefined) return refused("notFound", `master ${key}`)

	const unparsed = allParsed(deck)

	if (unparsed !== undefined) return unparsed

	const slides = slidesOf(deck, op.slides ?? deck.slides)

	if (isRefused(slides)) return slides

	const before = stateOf(deck)
	const own = (): SlideNode[] =>
		deck.layouts.map(ref => deck.nodes.get(ref)).filter((node): node is SlideNode => node?.parent === master.ref)

	for (const slide of slides) {
		const current = slide.parent === undefined ? undefined : deck.nodes.get(slide.parent)

		if (current?.parent === master.ref) continue

		const layouts = own()
		const type = current?.layoutType
		let target =
			layouts.find(layout => type !== undefined && layout.layoutType === type) ??
			(deck.format === "odp" ? undefined : layouts.find(layout => layout.layoutType === targetLayoutType(current)))

		if (target === undefined && deck.format === "odp" && current !== undefined)
			target = synthesizedLayout(deck, master, current, context.newSlideRef())

		target ??= layouts[0]

		if (target === undefined || target.ref === slide.parent) continue

		slide.parent = target.ref
		slide.revision++
	}

	dropUnusedGallery(deck)

	return themeApplied(deck, { ...op, slides: slides.map(slide => slide.ref) }, before)
}

function setTheme(deck: Deck, op: SetTheme, context: ApplyContext): ApplyResult<SetTheme> {
	const prior = PRIOR.get(op)

	if (prior !== undefined) {
		const before = stateOf(deck)
		const refusal = restore(deck, prior, designReadingOf(context))

		if (refusal !== undefined) return refusal

		const applied = themeApplied(deck, op, before)

		return applied
	}

	return op.theme.kind === "gallery"
		? applyGallery(deck, op, op.theme.id, op.theme.variant, context, MADE.get(op))
		: applyDeckTheme(deck, op, op.theme.part, context)
}

type SetVariant = Extract<DesignOp, { kind: "setVariant" }>

// A variant of a master's gallery theme: that theme again in the variant, for the slides on the master.
function setVariant(deck: Deck, op: SetVariant, context: ApplyContext): ApplyResult<SetVariant> {
	const master = deck.nodes.get(op.master)

	if (master?.kind !== "master") return refused("notFound", `master ${String(op.master)}`)

	const theme = masterGalleryTheme(deck, master)

	if (theme === undefined) return refused("unsupported", "a variant of a theme that is not one of ours")

	const unparsed = allParsed(deck)

	if (unparsed !== undefined) return unparsed

	const slides = deck.slides.filter(ref => {
		const node = deck.nodes.get(ref)

		return node !== undefined && masterOfSlide(deck, node) === master.ref
	})
	const applied = applyGallery(
		deck,
		{ family: "design", kind: "setTheme", theme: { kind: "gallery", id: theme.id, variant: op.variant }, slides },
		theme.id,
		op.variant,
		context,
		MADE.get(op)
	)

	if (applied.kind === "refused") return applied

	const touches = TOUCHES.get(applied.op)
	const made = MADE.get(applied.op)

	if (touches !== undefined) TOUCHES.set(op, touches)
	if (made !== undefined) MADE.set(op, made)

	return { kind: "applied", inverse: applied.inverse, op }
}

// --- setSize ---

type SetSize = Extract<DesignOp, { kind: "setSize" }>

function scaledXfrm(xfrm: Xfrm, s: number, dx: number, dy: number): Xfrm {
	return {
		...xfrm,
		x: Math.round(xfrm.x * s + dx),
		y: Math.round(xfrm.y * s + dy),
		cx: Math.round(xfrm.cx * s),
		cy: Math.round(xfrm.cy * s)
	}
}

// ST_SlideSizeCoordinate (§19.7.16): 914400 to 51206400 EMU.
const MIN_SIZE = 914_400
const MAX_SIZE = 51_206_400

// The content a scaled change replaced, by the size op of its inverse: what the undo puts back (designScale.ts), and
// the change's scale.
const RESTORE = new WeakMap<DesignOp, { readonly values: unknown[]; readonly scale: number }>()

// The text scale the deck's content took since its base file was read (by the base's epoch): ODP writes it into the
// font sizes of styles.xml, which the model does not hold.
const TEXT_SCALES = new WeakMap<Deck, { readonly epoch: number; readonly scale: number }>()

function baseEpoch(deck: Deck): number {
	for (const ref of deck.masters) {
		const epoch = deck.nodes.get(ref)?.src?.epoch

		if (epoch !== undefined) return epoch
	}

	return 0
}

export function textScaleOf(deck: Deck): number {
	const held = TEXT_SCALES.get(deck)

	return held !== undefined && held.epoch === baseEpoch(deck) ? held.scale : 1
}

function scaleText(deck: Deck, factor: number): void {
	TEXT_SCALES.set(deck, { epoch: baseEpoch(deck), scale: textScaleOf(deck) * factor })
}

// A size change's mapping of the page: x · scale + dx, y · scale + dy (EMU).
export interface PageMapping {
	readonly scale: number
	readonly dx: number
	readonly dy: number
}

const UNMAPPED: PageMapping = { scale: 1, dx: 0, dy: 0 }

// How many size changes that moved the content are in effect since the base file was read (an undo of one takes one
// off; after a save, its undo counts -1): none, and every master shape stands at its source box. `mapping` is theirs
// composed: where a source position is now.
const BOX_MOVES = new WeakMap<Deck, { readonly epoch: number; readonly moves: number; readonly mapping: PageMapping }>()
// The size ops of inverses that move the content back, with the mapping of the change they undo.
const MOVES_BACK = new WeakMap<DesignOp, PageMapping>()

export function boxesMovedSinceBase(deck: Deck): boolean {
	const held = BOX_MOVES.get(deck)

	return held !== undefined && held.epoch === baseEpoch(deck) && held.moves !== 0
}

// The page mapping of the size changes in effect since the base file was read.
export function pageMappingSinceBase(deck: Deck): PageMapping {
	const held = BOX_MOVES.get(deck)

	return held !== undefined && held.epoch === baseEpoch(deck) ? held.mapping : UNMAPPED
}

function countMove(deck: Deck, step: number, by: PageMapping): void {
	const held = BOX_MOVES.get(deck)
	const epoch = baseEpoch(deck)
	const prior = held?.epoch === epoch ? held : { moves: 0, mapping: UNMAPPED }
	const mapping: PageMapping = {
		scale: prior.mapping.scale * by.scale,
		dx: prior.mapping.dx * by.scale + by.dx,
		dy: prior.mapping.dy * by.scale + by.dy
	}

	BOX_MOVES.set(deck, { epoch, moves: prior.moves + step, mapping })
}

// The nodes whose content a size change scales: every master, layout and slide but a gallery master's (made again at
// the new size).
function scaledNodes(deck: Deck, gallery: ReadonlyMap<SlideRef, GalleryDesign> | undefined): SlideNode[] | Refused {
	const out: SlideNode[] = []

	for (const ref of [...deck.masters, ...deck.layouts, ...deck.slides]) {
		const node = deck.nodes.get(ref)

		if (node === undefined) return refused("notFound", `slide ${String(ref)} is not parsed`)

		const owner = node.kind === "master" ? node.ref : node.kind === "layout" ? node.parent : undefined

		if (owner === undefined || gallery?.has(owner) !== true) out.push(node)
	}

	return out
}

// Font sizes, spacing and tables of `nodes` scaled (or put back) by `scaler`; `boxes` the frames' boxes before and
// after, for a table's columns and rows.
function scaleContent(
	deck: Deck,
	nodes: readonly SlideNode[],
	scaler: ContentScaler,
	boxes: ReadonlyMap<ShapeNode, { readonly before: Xfrm; readonly after: Xfrm }>,
	touches: Touch[]
): void {
	const shape = (node: SlideNode, each: ShapeNode, top: boolean): void => {
		// A master's field a slide shows (locked "master") follows its master like the master's own shapes.
		if (each.lock !== undefined && each.synthetic !== true) return

		let touched = false

		if (each.text !== undefined) {
			each.text = scaler.body(each.text)
			touched = true
		}

		if (each.frame?.kind === "table") {
			each.frame = { kind: "table", table: scaler.table(each.frame.table, top, boxes.get(each)) }
			touched = true
		}

		if (touched)
			touches.push({
				kind: "shape",
				slide: node.ref,
				shape: each.id,
				dirt: each.frame === undefined ? { kind: "text" } : { kind: "node" }
			})

		for (const child of each.children ?? []) shape(node, child, false)
	}

	for (const node of nodes) {
		if (node.txStyles !== undefined) {
			node.txStyles = {
				title: scaler.listStyle(node.txStyles.title, true),
				body: scaler.listStyle(node.txStyles.body, true),
				other: scaler.listStyle(node.txStyles.other, true)
			}
			touches.push(slideTouch(node.ref, { kind: "node" }))
		}

		for (const each of node.shapes) shape(node, each, true)

		node.revision++
	}

	// ODP's defaults are its styles.xml's, scaled there by the save (textScaleOf).
	if (deck.format === "pptx") {
		deck.defaultTextStyle = scaler.listStyle(deck.defaultTextStyle, true)
		touches.push({ kind: "presentation", what: "defaults" })
	}
}

// What a scaled size change will touch, before it applies (the engine reads each key's state before the op): every
// box it moves, every text and table it scales, the masters' text styles and the deck's default text style.
export function predictedSizeTouches(deck: Deck, op: DeckOp): Touch[] {
	if (op.family !== "design" || op.kind !== "setSize" || op.scale === "none") return []

	const nodes = scaledNodes(deck, GALLERY.get(deck))

	if (isRefused(nodes)) return []

	const out: Touch[] = deck.format === "pptx" ? [{ kind: "presentation", what: "defaults" }] : []
	const shape = (node: SlideNode, each: ShapeNode, top: boolean): void => {
		if (top && each.xfrm !== undefined && node.synthetic !== true)
			out.push({ kind: "shape", slide: node.ref, shape: each.id, dirt: { kind: "xfrm" } })
		if (each.lock !== undefined) return
		if (each.frame?.kind === "table") out.push({ kind: "shape", slide: node.ref, shape: each.id, dirt: { kind: "node" } })
		else if (each.text !== undefined) out.push({ kind: "shape", slide: node.ref, shape: each.id, dirt: { kind: "text" } })

		for (const child of each.children ?? []) shape(node, child, false)
	}

	for (const node of nodes) {
		if (node.txStyles !== undefined) out.push(slideTouch(node.ref, { kind: "node" }))

		for (const each of node.shapes) shape(node, each, true)
	}

	return out
}

function setSize(deck: Deck, op: SetSize, context: ApplyContext): ApplyResult<SetSize> {
	const { cx, cy } = op

	if (![cx, cy].every(value => Number.isInteger(value) && value >= MIN_SIZE && value <= MAX_SIZE))
		return refused("malformed", "slide size")

	const stylesless = withoutStyles(deck, context)

	if (stylesless !== undefined) return stylesless

	const from = { ...deck.size }
	const inverse: DeckOp[] = []
	const touches: Touch[] = [{ kind: "presentation", what: "size" }]
	const scaled: { readonly node: SlideNode; readonly shape: ShapeNode; readonly xfrm: Xfrm }[] = []
	const gallery = GALLERY.get(deck)
	const reading = designReadingOf(context)
	const restoring = RESTORE.get(op)
	let recorded: { readonly values: unknown[]; readonly scale: number } | undefined
	let moved: PageMapping | undefined

	if (gallery !== undefined && [...gallery.keys()].some(ref => deck.masters.includes(ref)) && reading === undefined)
		return refused("notImplemented", "design parts in this session")

	if (op.scale !== "none") {
		const unparsed = allParsed(deck)

		if (unparsed !== undefined) return unparsed

		// Ensure fit keeps everything on the slide (the smaller ratio); maximize fills it (the larger). Content is
		// centred on the new slide either way.
		const s = op.scale === "ensureFit" ? Math.min(cx / from.cx, cy / from.cy) : Math.max(cx / from.cx, cy / from.cy)
		const dx = (cx - from.cx * s) / 2
		const dy = (cy - from.cy * s) / 2
		const nodes = scaledNodes(deck, gallery)

		if (isRefused(nodes)) return nodes

		// A locked shape is written as its source: one the change would move or scale is refused, never left behind.
		const moves = s !== 1 || Math.round(dx) !== 0 || Math.round(dy) !== 0

		for (const node of nodes)
			for (const shape of node.shapes)
				if (
					shape.synthetic !== true &&
					((moves && shape.lock !== undefined && shape.xfrm !== undefined && node.synthetic !== true) ||
						(s !== 1 && holdsLock(shape)))
				)
					return refused("locked", `${shape.name || "a shape"} is locked and would not follow the slide size`)

		const unmovable = moves ? reading?.masterMoveRefusal?.(deck) : undefined

		if (unmovable !== undefined) return unmovable

		const boxes = new Map<ShapeNode, { readonly before: Xfrm; readonly after: Xfrm }>()

		for (const node of nodes) {
			if (node.synthetic === true) continue

			for (const shape of node.shapes) {
				if (shape.xfrm === undefined) continue

				scaled.push({ node, shape, xfrm: shape.xfrm })
				shape.xfrm = scaledXfrm(shape.xfrm, s, dx, dy)
				boxes.set(shape, { before: scaled[scaled.length - 1]?.xfrm ?? shape.xfrm, after: shape.xfrm })
				touches.push({ kind: "shape", slide: node.ref, shape: shape.id, dirt: { kind: "xfrm" } })
				node.revision++
			}
		}

		if (moves) {
			moved = { scale: s, dx, dy }
			countMove(deck, 1, moved)
		}

		if (s !== 1) {
			const scaler = new ContentScaler(s)

			scaleContent(deck, nodes, scaler, boxes, touches)
			scaleText(deck, s)
			recorded = { values: scaler.values, scale: s }
		}

		// The inverse puts every xfrm back exactly (scaling back would round).
		for (const { node, shape, xfrm } of scaled)
			inverse.push({ family: "shape", kind: "setXfrm", target: { slide: node.ref, id: shape.id }, xfrm })
	} else if (restoring !== undefined) {
		const nodes = scaledNodes(deck, gallery)

		if (isRefused(nodes)) return nodes

		scaleContent(deck, nodes, new ContentScaler(undefined, restoring.values), new Map(), touches)
		scaleText(deck, 1 / restoring.scale)
	}

	const undone = MOVES_BACK.get(op)

	if (undone !== undefined) countMove(deck, -1, { scale: 1 / undone.scale, dx: -undone.dx / undone.scale, dy: -undone.dy / undone.scale })

	deck.size = { cx, cy, ...(op.type === undefined ? {} : { type: op.type }) }
	deck.revision++

	// Gallery masters follow the size: their parts made again.
	for (const design of gallery?.values() ?? []) {
		if (!deck.masters.includes(design.master) || reading === undefined) continue

		const refusal = holdGallery(deck, design, reading, true)

		if (refusal !== undefined) return refusal
	}

	for (const ref of deck.slides) touches.push(slideTouch(ref, { kind: "slidePart", part: "attributes" }))

	const back: SetSize = {
		family: "design",
		kind: "setSize",
		cx: from.cx,
		cy: from.cy,
		...(from.type === undefined ? {} : { type: from.type }),
		scale: "none"
	}

	if (recorded !== undefined) RESTORE.set(back, recorded)
	if (moved !== undefined) MOVES_BACK.set(back, moved)

	TOUCHES.set(op, touches)
	TOUCHES.set(back, touches)

	return {
		kind: "applied",
		inverse: { ops: [back, ...inverse], bytes: 64 + 48 * scaled.length + 16 * (recorded?.values.length ?? 0) },
		op
	}
}

// --- setBackground ---

type SetBackground = Extract<DesignOp, { kind: "setBackground" }>

// An image a picture background brings (the page's file), when the op carries one.
function imageOf(op: SetBackground): InsertedImage | undefined {
	return (op as SetBackground & { readonly image?: InsertedImage }).image
}

function setBackground(deck: Deck, op: SetBackground, context: ApplyContext): ApplyResult<SetBackground> {
	const refs = op.slides === "all" ? deck.slides : op.slides
	const nodes = slidesOf(deck, refs)

	if (isRefused(nodes)) return nodes

	let given = op.background
	const image = imageOf(op)

	// A gradient, pattern or picture is a drawing resource of styles.xml.
	if (given?.kind === "fill" && given.fill.kind !== "solid") {
		const stylesless = withoutStyles(deck, context)

		if (stylesless !== undefined) return stylesless
	}

	if (given?.kind === "fill" && given.fill.kind === "picture" && image !== undefined) {
		const id = registerInsertedImage(deck, image, given.fill.inserted)

		given = { ...given, fill: { ...given.fill, inserted: id } }
	}

	if (given?.kind === "fill" && given.fill.kind === "picture" && given.fill.part === undefined && given.fill.inserted === undefined)
		return refused("malformed", "a picture background without its image")

	const inverse: DeckOp[] = []
	let bytes = 0

	for (const node of nodes) {
		const prior = node.background
		let raw = prior === undefined ? undefined : BACKGROUND_RAWS.get(prior)

		if (raw === undefined && prior?.src !== undefined) {
			const source = context.sourceBytes(prior.src)

			if (!(source instanceof Uint8Array)) return source

			raw = source
		}

		inverse.push({
			family: "design",
			kind: "setBackground",
			slides: [node.ref],
			background: prior,
			...(op.hideGraphics === undefined ? {} : { hideGraphics: !node.showMasterShapes }),
			...(raw === undefined ? {} : { raws: [raw] })
		})
		bytes += 64 + (raw?.length ?? 0)
	}

	nodes.forEach((node, index) => {
		const raw = op.raws?.[index]

		if (given === undefined) {
			delete node.background
		} else if (raw !== undefined) {
			node.background = given
			BACKGROUND_RAWS.set(given, raw)
		} else {
			const { src: _src, ...own } = given

			node.background = own as Background
		}

		if (op.hideGraphics !== undefined) node.showMasterShapes = !op.hideGraphics

		node.revision++
	})

	const applied: SetBackground = { ...op, slides: nodes.map(node => node.ref), background: given }

	TOUCHES.set(applied, backgroundTouches(applied))

	return { kind: "applied", inverse: { ops: inverse, bytes }, op: applied }
}

function backgroundTouches(op: SetBackground): Touch[] {
	return op.slides === "all"
		? []
		: op.slides.flatMap(slide => [
				slideTouch(slide, { kind: "slidePart", part: "background" }),
				...(op.hideGraphics === undefined ? [] : [slideTouch(slide, { kind: "slidePart", part: "attributes" })])
			])
}

function applyOne(deck: Deck, op: DesignOp, context: ApplyContext): ApplyResult<DesignOp> {
	switch (op.kind) {
		case "setTheme":
			return setTheme(deck, op, context)
		case "setVariant":
			return setVariant(deck, op, context)
		case "setSize":
			return setSize(deck, op, context)
		case "setBackground":
			return setBackground(deck, op, context)
	}
}

// --- ODP: the source's own bytes back after an undo across a save ---
//
// An inverse holds the source markup of each page the op changed (a page whose revision moved), and, when the op
// changed what styles.xml holds while styles.xml was still the file's own, its bytes. An undo after a save puts the
// pages back on their held markup (heldPage.ts), so the writer copies a page the undo returned to its source state;
// and styles.xml, back in the state its bytes were held in, is written as those bytes (heldStyles). A state of
// styles.xml is a token: an op that changes it makes a new one (the same one again for a redo from the same state),
// its inverse puts the one it found back. Only parts the op changes are held, and they count in the inverse's bytes.

interface StylesState {
	readonly epoch: number
	// The state the base file's styles.xml is in, and the deck's now.
	readonly base: object
	current: object
}

interface DesignHolds {
	readonly pages: readonly (readonly [SlideRef, Uint8Array])[]
	readonly styles?: { readonly state: object; readonly bytes?: Uint8Array }
}

const STYLES = new WeakMap<Deck, StylesState>()
// The styles.xml bytes an undo put the deck's state back to.
const STYLES_HELD = new WeakMap<Deck, { readonly state: object; readonly bytes: Uint8Array }>()
// What an op made of a state it applied from, so a redo from the same state makes the same one.
const STYLES_AFTER = new WeakMap<DesignOp, { readonly before: object; readonly after: object }>()
// By an inverse's first op: what it puts back.
const HOLDS = new WeakMap<DesignOp, DesignHolds>()
const INVERSES = new WeakSet<DesignOp>()

function stylesState(deck: Deck): StylesState {
	const held = STYLES.get(deck)
	const epoch = baseEpoch(deck)

	if (held !== undefined && held.epoch === epoch) return held

	// A save since: its styles.xml is the state the deck was saved in.
	const current = held?.current ?? {}
	const state: StylesState = { epoch, base: current, current }

	STYLES.set(deck, state)

	return state
}

// The styles.xml bytes the save writes for an ODP deck an undo put back in a state the file had before a save since.
export function heldStyles(deck: Deck): Uint8Array | undefined {
	const state = stylesState(deck)
	const held = STYLES_HELD.get(deck)

	return held !== undefined && held.state === state.current && state.current !== state.base ? held.bytes : undefined
}

// The gallery masters the deck has, in order: styles.xml holds a master page for each.
function galleryKey(deck: Deck): string {
	const gallery = GALLERY.get(deck)

	return deck.masters.filter(ref => gallery?.has(ref) === true).join(",")
}

// Whether an op (not an inverse) changed what styles.xml holds: the page layouts' size, a gallery master page, a
// drawing resource a background names.
function stylesChanged(op: DesignOp, gallery: string, deck: Deck): boolean {
	switch (op.kind) {
		case "setSize":
			return true
		case "setBackground":
			return op.background?.kind === "fill" && op.background.fill.kind !== "solid"
		case "setTheme":
		case "setVariant":
			return galleryKey(deck) !== gallery
	}
}

function applyOdp(deck: Deck, op: DesignOp, context: ApplyContext): ApplyResult<DesignOp> {
	const reading = sourceReading(context)
	const holds = HOLDS.get(op)

	// An inverse's held pages first: nothing changes before every one reads.
	if (holds !== undefined && reading !== undefined) {
		for (const [ref, raw] of holds.pages) {
			const node = deck.nodes.get(ref)
			const failed = node?.kind === "slide" ? onHeldPage(deck, node, raw, reading) : undefined

			if (failed !== undefined) return refused("stale", failed)
		}
	}

	const inverse = INVERSES.has(op)
	const styles = stylesState(deck)
	const before = styles.current
	const revisions = inverse ? undefined : deck.slides.map(ref => deck.nodes.get(ref)?.revision)
	const gallery = galleryKey(deck)
	const result = applyOne(deck, op, context)

	if (result.kind !== "applied") return result

	if (holds?.styles !== undefined) {
		styles.current = holds.styles.state

		if (holds.styles.bytes !== undefined) STYLES_HELD.set(deck, { state: holds.styles.state, bytes: holds.styles.bytes })
	}

	if (inverse || revisions === undefined) return result

	const changed = stylesChanged(op, gallery, deck)

	if (changed) {
		const after = STYLES_AFTER.get(op)

		styles.current = after?.before === before ? after.after : {}
		STYLES_AFTER.set(op, { before, after: styles.current })
	}

	const pages: (readonly [SlideRef, Uint8Array])[] = []
	let bytes = 0

	for (const [index, ref] of deck.slides.entries()) {
		const node = deck.nodes.get(ref)
		const markup = node === undefined || node.revision === revisions[index] ? undefined : pageMarkup(node, reading)

		if (markup === undefined) continue

		pages.push([ref, markup])
		bytes += 16 + markup.length
	}

	const stylesBytes = changed && before === styles.base ? designReadingOf(context)?.stylesBytes?.() : undefined
	const back: DesignHolds = {
		pages,
		...(changed ? { styles: { state: before, ...(stylesBytes === undefined ? {} : { bytes: stylesBytes }) } } : {})
	}
	const ops = result.inverse.ops

	for (const each of ops) if (each.family === "design") INVERSES.add(each)

	const first = ops[0]

	if (first?.family !== "design") return result

	HOLDS.set(first, back)

	return { ...result, inverse: { ops, bytes: result.inverse.bytes + bytes + (stylesBytes?.length ?? 0) } }
}

export const applyDesign: ApplyFamily<DesignOp> = {
	apply(deck, op, context): ApplyResult<DesignOp> {
		return deck.format === "odp" ? applyOdp(deck, op, context) : applyOne(deck, op, context)
	},
	// Before an op applies, what it names; once applied (and for its inverse), all it touched.
	touches(op) {
		const known = TOUCHES.get(op)

		if (known !== undefined) return known

		switch (op.kind) {
			case "setBackground":
				return backgroundTouches(op)
			case "setSize":
				return [{ kind: "presentation", what: "size" }]
			case "setTheme":
				return (op.slides ?? []).map(slide => slideTouch(slide, { kind: "node" }))
			case "setVariant":
				return []
		}
	}
}

// --- what the Design tab shows ---

// A theme as the design info needs it (core/presentation/theme.ts PresentationTheme has it).
export interface DesignThemeColors {
	readonly colors: ReadonlyMap<string, string>
	readonly major: { readonly latin: string }
	readonly minor: { readonly latin: string }
}

// The deck's masters as "the file's own themes": names, our gallery theme where it is one, colours (through each
// master's colour map) and fonts. `theme` reads a theme part (pptx); an ODP master has none, so its solid background
// stands in for its colours.
export function designInfo(deck: Deck, theme: (part: string) => DesignThemeColors | undefined): PresentationDesignInfo {
	const themes: DesignThemeInfo[] = []

	for (const ref of deck.masters) {
		const master = deck.nodes.get(ref)

		if (master === undefined) continue

		const gallery = masterGalleryTheme(deck, master)
		const read = master.theme === undefined ? undefined : theme(master.theme.part)
		const map = master.clrMap ?? DEFAULT_CLR_MAP
		const slot = (key: keyof typeof map): string | undefined => read?.colors.get(map[key])
		const solid =
			master.background?.kind === "fill" && master.background.fill.kind === "solid" && master.background.fill.color.kind === "srgb"
				? master.background.fill.color.rgb
				: undefined
		const background = slot("bg1") ?? solid
		const text = slot("tx1")
		const accents = (["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"] as const).flatMap(key => {
			const value = read?.colors.get(key)

			return value === undefined ? [] : [value]
		})

		themes.push({
			master: ref,
			key: deckThemeKey(master),
			...(master.name === undefined || master.name === "" ? {} : { name: master.name }),
			...(gallery === undefined ? {} : { gallery }),
			...(background === undefined
				? {}
				: { colors: { background, text: text ?? (isDark(background) ? "FFFFFF" : "000000"), accents } }),
			...(read === undefined ? {} : { fonts: { major: read.major.latin, minor: read.minor.latin } })
		})
	}

	return { themes }
}

function isDark(hex: string): boolean {
	const value = Number.parseInt(hex, 16)

	return ((value >> 16) & 255) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114 < 128
}

// Every layout as the page offers it (OpenInfo.layouts), master by master: its master, type and name.
export function designLayouts(
	deck: Deck
): { readonly ref: SlideRef; readonly master: SlideRef; readonly type?: string; readonly name?: string }[] {
	return deck.layouts.flatMap(ref => {
		const node = deck.nodes.get(ref)

		return node === undefined || node.parent === undefined
			? []
			: [
					{
						ref,
						master: node.parent,
						...(node.layoutType === undefined ? {} : { type: node.layoutType }),
						...(node.name === undefined ? {} : { name: node.name })
					}
				]
	})
}
