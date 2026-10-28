import { relationshipKind } from "../../../docx/index"
import { partKey } from "../../../opc/index"
import { backgroundRaw, galleryDesigns, type GalleryDesign } from "../../../presentation/edit/apply/design"
import type { DeckChanges } from "../../../presentation/edit/apply"
import { refused, type Background, type Deck, type Refused, type SlideRef } from "../../../presentation/model"
import { colorXml, fillXml } from "../../../presentation/render/markup"
import { filenTheme } from "../../../templates/themes/catalog"
import { LAYOUT_TYPES, layoutXml, masterXml, themeXml } from "../../../templates/themes/pptx"
import { decodeUtf8, encodeUtf8, escapeAttribute, type XmlDocument } from "../../../xml/index"
import { G, P_MAIN, partReader } from "../../read/xml"
import { PART_CONTENT_TYPES, RELATIONSHIPS, zipName, type PackageWriter, type PendingRelationship } from "../parts"
import type { EmitPiece, PptxEmitFamily } from "../types"
import { imageId } from "./picture"
import { listStyleXml } from "./text"
import { URIS, type EmitContext } from "./shape"

// The design family's PresentationML: a slide's p:bg (ECMA-376 Part 1 §19.3.1.1; a fill in p:bgPr, a theme style in
// p:bgRef), written where the splice asks for the background, and the save's design step (spliceDesign): the slide
// size (p:sldSz, §19.2.1.39), the gallery masters a theme op added (their theme, master and layout parts, made at the
// deck's size), the masters it dropped (with the parts only they used), the master list (p:sldMasterIdLst) and each
// slide's relationship to its layout. A slide part itself is never rewritten by a theme change.

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const SLIDE_MASTER_RELATIONSHIP = `${RELATIONSHIPS}slideMaster`
const SLIDE_LAYOUT_RELATIONSHIP = `${RELATIONSHIPS}slideLayout`
const THEME_RELATIONSHIP = `${RELATIONSHIPS}theme`
// p:sldMasterId@id and p:sldLayoutId@id share one space from 2^31 (§19.2.1.34, §19.3.1.41).
const FIRST_ID = 2_147_483_648
const LAST_ID = 4_294_967_295

// p:bg of a background as the model holds it ("" for none: the slide inherits its layout's); the source's bytes for
// one an undo restored.
export function backgroundMarkup(context: EmitContext, background: Background | undefined): string | Uint8Array | Refused {
	if (background === undefined) return ""

	const raw = backgroundRaw(background)

	if (raw !== undefined) return raw

	if (background.kind === "ref")
		return `<p:bg><p:bgRef idx="${String(background.idx)}">${background.color === undefined ? "" : colorXml(background.color)}</p:bgRef></p:bg>`

	let failure: Refused | undefined
	const fill = fillXml(background.fill, picture => {
		const id = imageId(context, picture)

		if (typeof id === "string") return id

		failure = id

		return undefined
	})

	return failure ?? `<p:bg><p:bgPr${background.shadeToTitle === true ? ' shadeToTitle="1"' : ""}>${fill}<a:effectLst/></p:bgPr></p:bg>`
}

export const emitPptxDesign: PptxEmitFamily = {
	// A slide's background edited in place in its spliced part (the splice asks the family and places nothing of it
	// itself); without a source part, the markup.
	emit(request, context) {
		if (request.shape !== undefined) return refused("unsupported", "pptx emit design: a shape's element")

		const markup = backgroundMarkup(context as EmitContext, request.slide.background)

		if (typeof markup !== "string" && !(markup instanceof Uint8Array)) return markup

		const empty = typeof markup === "string" && markup === ""
		const document = context.document

		if (document === undefined) return { kind: "markup", pieces: empty ? [] : [markup] }

		const r = partReader(document)
		const cSld = r.child(document.documentElement(), G.P, "cSld")

		if (cSld < 0) return refused("malformed", "A slide without p:cSld")

		const editor = context.parts.editor(context.parts.owner)
		const bg = r.child(cSld, G.P, "bg")

		if (bg >= 0) {
			if (empty) editor.remove(bg)
			else editor.replace(bg, markup)
		} else if (!empty) {
			editor.prepend(cSld, markup)
		}

		return { kind: "markup", pieces: [] }
	}
}

// --- the save's design step ---

interface BaseMaster {
	readonly id: number
	readonly rId: string
	readonly part: string
	readonly node: number
}

export interface DesignSpliceInput {
	readonly writer: PackageWriter
	readonly deck: Deck
	readonly changes: DeckChanges
	// The main part's zip name ("ppt/presentation.xml").
	readonly mainPart: string
	// A slide's part in the package this save writes (zip name).
	readonly slidePart: (ref: SlideRef) => string | undefined
}

function layoutIdsOf(document: XmlDocument): number[] {
	const r = partReader(document)

	return r.children(r.child(document.documentElement(), G.P, "sldLayoutIdLst"), G.P, "sldLayoutId").flatMap(entry => {
		const id = r.int(entry, "id")

		return id === undefined ? [] : [id]
	})
}

// Writes the design changes into the package, once per save, after the slides and before presentation.xml's slide
// list. Nothing when the deck's size and masters are as the base package has them.
export async function spliceDesign(input: DesignSpliceInput): Promise<Refused | undefined> {
	const { writer, deck, changes, mainPart } = input
	const sized = changes.presentation.has("size")
	const gallery = galleryDesigns(deck)
	const masters = deck.masters.flatMap(ref => {
		const node = deck.nodes.get(ref)

		return node === undefined ? [] : [node]
	})

	const document = await writer.loadDocument(mainPart)
	const r = partReader(document)
	const root = document.documentElement()
	const relationships = await writer.loadRelationships(mainPart)
	const list = r.child(root, G.P, "sldMasterIdLst")
	const base: BaseMaster[] = []

	for (const entry of r.children(list, G.P, "sldMasterId")) {
		const rId = r.rel(entry, "id")
		const target = rId === undefined ? undefined : relationships.byId(rId)

		if (rId === undefined || target === undefined || target.external) continue

		base.push({ id: r.int(entry, "id") ?? 0, rId, part: target.target, node: entry })
	}

	const baseKeys = new Set(base.map(master => partKey(master.part)))
	const deckKeys = new Set(masters.map(master => partKey(zipName(master.part))))
	const added = masters.filter(master => !baseKeys.has(partKey(zipName(master.part))))
	const removed = base.filter(master => !deckKeys.has(partKey(master.part)))

	if (changes.presentation.has("defaults")) {
		const refusal = writeDefaults(input, document)

		if (refusal !== undefined) return refusal
	}

	if (sized) {
		const refusal = writeSize(input, document)

		if (refusal !== undefined) return refusal

		// The gallery masters the package has, made again at the new size.
		for (const master of masters) {
			const design = gallery.get(master.ref)
			const at = base.find(entry => partKey(entry.part) === partKey(zipName(master.part)))

			if (design === undefined || at === undefined) continue

			const rewritten = await rewriteGallery(input, design, at)

			if (rewritten !== undefined) return rewritten
		}
	}

	if (added.length === 0 && removed.length === 0) return undefined

	// Ids taken: every master's, and every kept master's layouts'.
	let next = FIRST_ID

	for (const master of base) {
		next = Math.max(next, master.id + 1)

		if (!removed.includes(master)) for (const id of layoutIdsOf(await writer.loadDocument(master.part))) next = Math.max(next, id + 1)
	}

	const ids = new Map<SlideRef, number>()

	for (const master of added) {
		const design = gallery.get(master.ref)

		if (design === undefined) return refused("failed", `The new master ${master.part} is not one the session made`)
		if (next + LAYOUT_TYPES.length > LAST_ID) return refused("tooLarge", "No free master id")

		const refusal = await addGallery(input, design, next)

		if (refusal !== undefined) return refusal

		ids.set(master.ref, next)
		next += LAYOUT_TYPES.length + 1
	}

	// Each slide onto its layout: only the relationship, the slide's markup stays.
	for (const ref of deck.slides) {
		const node = deck.nodes.get(ref)
		const part = input.slidePart(ref)
		const layout = node?.parent === undefined ? undefined : deck.nodes.get(node.parent)

		if (node === undefined || part === undefined || layout === undefined) continue

		const edit = await writer.loadRelationships(part)
		const current = edit.all().find(relationship => relationshipKind(relationship.type) === "slideLayout")
		const target = zipName(layout.part)

		if (current === undefined) edit.add(SLIDE_LAYOUT_RELATIONSHIP, target, false)
		else if (partKey(current.target) !== partKey(target)) edit.retarget(current.id, target)
	}

	// Dropped masters go with their layouts, their theme and what only they used; presentation.xml's relationships to
	// them go too (the list below no longer names them).
	if (removed.length > 0) {
		const dangling = async (source: string, relationship: PendingRelationship): Promise<void> => {
			if (partKey(source) === partKey(mainPart)) (await writer.loadRelationships(source)).remove(relationship.id)
		}

		await writer.removeWithOrphans(
			removed.map(master => master.part),
			dangling
		)
	}

	// The master list: kept entries as they are (their attributes and extensions), new ones written.
	const p = r.namespaces.prefixFor(root, P_MAIN) ?? "p"
	const rel = r.namespaces.prefixFor(root, URIS["r"] ?? "") ?? "r"
	const q = (local: string): string => (p === "" ? local : `${p}:${local}`)
	const entries = masters.map(master => {
		const kept = base.find(entry => partKey(entry.part) === partKey(zipName(master.part)))

		if (kept !== undefined) return decodeUtf8(document.bytes.subarray(document.start(kept.node), document.end(kept.node)))

		const rId = writer.relate(mainPart, zipName(master.part), SLIDE_MASTER_RELATIONSHIP)

		return `<${q("sldMasterId")} id="${String(ids.get(master.ref) ?? 0)}" ${rel}:id="${escapeAttribute(rId)}"/>`
	})
	const markup = `<${q("sldMasterIdLst")}>${entries.join("")}</${q("sldMasterIdLst")}>`
	const editor = writer.editor(mainPart)

	if (list >= 0) editor.replace(list, markup)
	else editor.prepend(root, markup)

	return undefined
}

// p:defaultTextStyle (§19.2.1.8) from the model (a scaled size change scales it), the source's extensions kept; placed
// before p:modifyVerifier and p:extLst when the part has none.
function writeDefaults(input: DesignSpliceInput, document: XmlDocument): Refused | undefined {
	const r = partReader(document)
	const root = document.documentElement()
	const node = r.child(root, G.P, "defaultTextStyle")
	const list = input.deck.defaultTextStyle

	// None (an undo back to a part without one): none written.
	if (list.def === undefined && list.levels.every(level => level === undefined)) {
		if (node >= 0) input.writer.editor(input.mainPart).remove(node)

		return undefined
	}

	const p = r.namespaces.prefixFor(root, P_MAIN) ?? "p"
	const context: EmitContext = { deck: input.deck, document, parts: input.writer.api(input.mainPart) }
	const pieces = listStyleXml(context, list, node, p === "" ? "defaultTextStyle" : `${p}:defaultTextStyle`)

	if (!Array.isArray(pieces)) return pieces as Refused

	const markup = (pieces as readonly EmitPiece[])
		.map(piece =>
			typeof piece === "string"
				? piece
				: piece instanceof Uint8Array
					? decodeUtf8(piece)
					: decodeUtf8(document.bytes.subarray(document.start(piece.hole), document.end(piece.hole)))
		)
		.join("")
	const editor = input.writer.editor(input.mainPart)

	if (node >= 0) {
		editor.replace(node, markup)

		return undefined
	}

	const after = [r.child(root, G.P, "modifyVerifier"), r.child(root, G.P, "extLst")].find(child => child >= 0)

	if (after === undefined) editor.append(root, markup)
	else editor.insertBefore(after, markup)

	return undefined
}

function writeSize(input: DesignSpliceInput, document: XmlDocument): Refused | undefined {
	const r = partReader(document)
	const size = r.child(document.documentElement(), G.P, "sldSz")
	const { cx, cy, type } = input.deck.size

	if (size < 0) return refused("malformed", "presentation.xml has no p:sldSz")

	const editor = input.writer.editor(input.mainPart)

	editor.setAttribute(size, "cx", String(cx))
	editor.setAttribute(size, "cy", String(cy))

	if (type === undefined) editor.removeAttribute(size, "type")
	else editor.setAttribute(size, "type", type)

	return undefined
}

// A gallery master's parts added: its theme, the master and its layouts, each with its relationships.
async function addGallery(input: DesignSpliceInput, design: GalleryDesign, masterId: number): Promise<Refused | undefined> {
	const { writer, deck } = input
	const theme = filenTheme(design.themeId)

	if (theme === undefined) return refused("unsupported", `theme ${design.themeId}`)

	const names = { theme: zipName(design.names.theme), master: zipName(design.names.master), layouts: design.names.layouts.map(zipName) }

	for (const name of [names.theme, names.master, ...names.layouts])
		if (!writer.claim(name)) return refused("failed", `The design part ${name} is taken`)

	writer.add(names.theme, PART_CONTENT_TYPES.theme, encodeUtf8(XML_DECLARATION + themeXml(theme, design.variant)))

	const layoutRefs = names.layouts.map((_, index) => ({ id: masterId + 1 + index, rId: `rId${String(index + 1)}` }))

	writer.add(
		names.master,
		PART_CONTENT_TYPES.slideMaster,
		encodeUtf8(XML_DECLARATION + masterXml(theme, design.variant, deck.size, layoutRefs))
	)

	const masterRelationships = await writer.loadRelationships(names.master)

	for (const [index, layout] of names.layouts.entries())
		masterRelationships.add(SLIDE_LAYOUT_RELATIONSHIP, layout, false, `rId${String(index + 1)}`)

	masterRelationships.add(THEME_RELATIONSHIP, names.theme, false, `rId${String(names.layouts.length + 1)}`)

	for (const [index, name] of names.layouts.entries()) {
		const type = LAYOUT_TYPES[index]

		if (type === undefined) continue

		writer.add(name, PART_CONTENT_TYPES.slideLayout, encodeUtf8(XML_DECLARATION + layoutXml(type, deck.size)))
		;(await writer.loadRelationships(name)).add(SLIDE_MASTER_RELATIONSHIP, names.master, false, "rId1")
	}

	return undefined
}

// A gallery master the package has, made again at the deck's size under the ids and relationships it was written
// with.
async function rewriteGallery(input: DesignSpliceInput, design: GalleryDesign, at: BaseMaster): Promise<Refused | undefined> {
	const { writer, deck } = input
	const theme = filenTheme(design.themeId)

	if (theme === undefined) return refused("unsupported", `theme ${design.themeId}`)

	const masterDocument = await writer.loadDocument(at.part)
	const r = partReader(masterDocument)
	const entries = r.children(r.child(masterDocument.documentElement(), G.P, "sldLayoutIdLst"), G.P, "sldLayoutId")
	const layoutRefs = entries.map(entry => ({ id: r.int(entry, "id") ?? 0, rId: r.rel(entry, "id") ?? "" }))

	if (layoutRefs.length !== LAYOUT_TYPES.length) return refused("malformed", `The gallery master ${at.part} lost its layouts`)

	writer.replace(at.part, encodeUtf8(XML_DECLARATION + masterXml(theme, design.variant, deck.size, layoutRefs)))
	writer.replace(zipName(design.names.theme), encodeUtf8(XML_DECLARATION + themeXml(theme, design.variant)))

	for (const [index, name] of design.names.layouts.entries()) {
		const type = LAYOUT_TYPES[index]

		if (type !== undefined) writer.replace(zipName(name), encodeUtf8(XML_DECLARATION + layoutXml(type, deck.size)))
	}

	return undefined
}
