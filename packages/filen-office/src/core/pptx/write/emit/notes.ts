import { partKey } from "../../../opc/index"
import type { DeckChanges } from "../../../presentation/edit/apply"
import { formerName, noteFormerName } from "../../../presentation/issuedNames"
import { refused, type Deck, type Refused, type SlideNode, type SlideRef } from "../../../presentation/model"
import { madeNotesPart } from "../../../presentation/notes"
import { encodeUtf8, escapeAttribute } from "../../../xml/index"
import { G, P_MAIN, partReader } from "../../read/xml"
import { emitFamilyOf, emitPptx } from "../emit"
import { PART_CONTENT_TYPES, RELATIONSHIPS, modelName, zipName, type PackageWriter } from "../parts"
import type { EmitPiece, EmitRequest, EmitResult, PptxEmitFamily } from "../types"
import { URIS, type EmitContext } from "./shape"
import { slideRoot } from "./slide"

// The parts a slide's notes need (ECMA-376 Part 1 §13.3.5 Notes Master part, §13.3.6 Notes Slide part), written after
// the splice writer's slides: a notes slide the session made (apply/notes.ts) gets its part, related from its slide and
// relating its slide and notes master back; a notes master the session made gets its part, a copy of the first
// slide master's theme, and its p:notesMasterIdLst entry in presentation.xml. An undo after a save takes them out
// again (the notes slide its slide no longer has; the session's notes master no notes slide uses), so the file is
// the one it was. The notes text itself is the text family's: an edited notes body is spliced as any shape's.

const NOTES_SLIDE = `${RELATIONSHIPS}notesSlide`
const NOTES_MASTER = `${RELATIONSHIPS}notesMaster`
const SLIDE = `${RELATIONSHIPS}slide`
const THEME = `${RELATIONSHIPS}theme`
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

export interface ReviewSpliceInput {
	readonly writer: PackageWriter
	readonly deck: Deck
	readonly changes: DeckChanges
	// presentation.xml (zip name), loaded by the splice writer.
	readonly mainPart: string
	// A slide's part as this save writes it (zip name), and its p:sldId.
	readonly slidePart: (ref: SlideRef) => string | undefined
	readonly slideId: (ref: SlideRef) => number | undefined
}

// Slide-level requests of these families write no element of the slide: their parts are written by the hooks.
export const emitPptxNotes: PptxEmitFamily = {
	emit: request => (request.shape === undefined ? { kind: "unchanged" } : refused("unsupported", "pptx emit notes: a shape"))
}

function dispatch(request: EmitRequest, context: EmitContext): EmitResult {
	return emitPptx(emitFamilyOf(request), request, context)
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0

	for (const chunk of chunks) length += chunk.length

	const out = new Uint8Array(length)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

function piecesBytes(pieces: readonly EmitPiece[]): Uint8Array | Refused {
	const chunks: Uint8Array[] = [encodeUtf8(XML_DECLARATION)]

	for (const piece of pieces) {
		if (typeof piece === "string") chunks.push(encodeUtf8(piece))
		else if (piece instanceof Uint8Array) chunks.push(piece)
		else return refused("failed", "a model-written notes part names source markup")
	}

	return concat(chunks)
}

// A node written from the model alone into a new part `name`.
function modelPart(input: ReviewSpliceInput, node: SlideNode, name: string): Uint8Array | Refused {
	const context: EmitContext = {
		deck: input.deck,
		document: undefined,
		parts: input.writer.api(modelName(name)),
		mode: "model",
		slidePart: ref => {
			const part = input.slidePart(ref)

			return part === undefined ? undefined : modelName(part)
		},
		dispatch
	}
	const result = slideRoot(context, node)

	if (result.kind === "refused") return result
	if (result.kind === "unchanged") return refused("failed", "a notes part with no markup")

	return piecesBytes(result.pieces)
}

async function relationOfType(
	writer: PackageWriter,
	source: string,
	type: string
): Promise<{ readonly id: string; readonly target: string } | undefined> {
	const found = (await writer.loadRelationships(source)).all().find(relationship => relationship.type === type && !relationship.external)

	return found === undefined ? undefined : { id: found.id, target: found.target }
}

export async function spliceNotes(input: ReviewSpliceInput): Promise<Refused | undefined> {
	const { writer, deck } = input
	// The notes parts the deck's slides have now (by zip name): a slide that lost its notes may still relate one of them
	// in the package (a copy written while the notes were its source's), which then only loses that relationship.
	const inUse = new Set<string>()

	for (const ref of deck.slides) {
		const notes = deck.nodes.get(ref)?.notes

		if (notes !== undefined) {
			const part = deck.nodes.get(notes)?.part

			if (part !== undefined) inUse.add(zipName(part))
		}
	}

	for (const ref of deck.slides) {
		const node = deck.nodes.get(ref)
		const slidePart = input.slidePart(ref)

		if (node === undefined || slidePart === undefined) continue

		const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

		if (notes === undefined) {
			// The notes slide an undo took back after a save: out of the package with its relationship.
			if (!writer.exists(slidePart) || writer.isAdded(slidePart)) continue

			const related = await relationOfType(writer, slidePart, NOTES_SLIDE)

			if (related === undefined || !writer.exists(related.target) || !madeNotesPart(deck, related.target)) continue

			if (!inUse.has(related.target)) writer.remove(related.target)
			;(await writer.loadRelationships(slidePart)).remove(related.id)
			continue
		}

		const name = zipName(notes.part)

		if (writer.exists(name)) {
			// A copy of notes the session made (no source markup): the splice writer copied the part as the package holds
			// it, which a later edit (of the original or the copy) is not in. Written from the model, as made notes are.
			if (notes.src === undefined && writer.isAdded(name)) {
				// Only the part this slide's copy relates as its notes is its own; one another copy took the name of is not.
				const related = await relationOfType(writer, slidePart, NOTES_SLIDE)

				if (related === undefined || partKey(related.target) !== partKey(name))
					return refused("failed", `The notes part ${name} is taken`)

				const bytes = modelPart(input, notes, name)

				if (!(bytes instanceof Uint8Array)) return bytes

				writer.replace(name, bytes)
			}

			continue
		}
		if (!writer.claim(name)) return refused("failed", `The notes part ${name} is taken`)

		writer.add(name, PART_CONTENT_TYPES.notesSlide, undefined)
		await writer.loadRelationships(name)

		const bytes = modelPart(input, notes, name)

		if (bytes instanceof Uint8Array) writer.replace(name, bytes)
		else return bytes

		const master = notes.parent === undefined ? undefined : deck.nodes.get(notes.parent)

		writer.relate(name, slidePart, SLIDE)
		if (master !== undefined) writer.relate(name, zipName(master.part), NOTES_MASTER)

		await writer.loadRelationships(slidePart)

		const previous = await relationOfType(writer, slidePart, NOTES_SLIDE)

		if (previous !== undefined) (await writer.loadRelationships(slidePart)).remove(previous.id)

		writer.relate(slidePart, name, NOTES_SLIDE)
	}

	// The master after the slides: the notes slides the save takes out no longer relate to a master it takes out.
	return notesMaster(input)
}

// The deck's notes master when the session made it (no source): its part, its theme and its entry in presentation.xml;
// a session-made master the deck dropped (an undo after the save that wrote it): out again.
async function notesMaster(input: ReviewSpliceInput): Promise<Refused | undefined> {
	const { writer, deck } = input
	const main = input.mainPart
	const relationships = await writer.loadRelationships(main)
	const related = relationships.all().find(relationship => relationship.type === NOTES_MASTER && !relationship.external)
	const master = deck.notesMaster === undefined ? undefined : deck.nodes.get(deck.notesMaster)
	const document = await writer.loadDocument(main)
	const r = partReader(document)
	const root = document.documentElement()

	if (master === undefined) {
		if (related === undefined || !writer.exists(related.target) || !madeNotesPart(deck, related.target) || !sessionMasterless(deck))
			return undefined

		const list = r.child(root, G.P, "notesMasterIdLst")

		if (list >= 0) writer.editor(main).remove(list)

		relationships.remove(related.id)
		await writer.removeWithOrphans([related.target], async (source, relationship) => {
			if (partKey(source) !== partKey(main)) (await writer.loadRelationships(source)).remove(relationship.id)
		})

		return undefined
	}

	const name = zipName(master.part)

	if (master.src !== undefined || writer.exists(name)) return undefined
	if (related !== undefined) return refused("failed", "A second notes master")
	if (!writer.claim(name)) return refused("failed", `The notes master part ${name} is taken`)

	writer.add(name, PART_CONTENT_TYPES.notesMaster, undefined)
	await writer.loadRelationships(name)

	const bytes = modelPart(input, master, name)

	if (!(bytes instanceof Uint8Array)) return bytes

	writer.replace(name, bytes)

	const theme = master.theme === undefined ? undefined : zipName(master.theme.part)

	if (theme === undefined || !writer.exists(theme)) return refused("failed", "A notes master without a theme")

	// The theme a save of the session wrote for this master before (an undo took it out, the redo writes it again)
	// keeps its name: the same state saves as the same bytes.
	const key = `${partKey(name)} ${THEME}`
	const copied = await writer.copyPart(theme, undefined, undefined, undefined, formerName(deck, key))

	noteFormerName(deck, key, copied)
	writer.relate(name, copied, THEME)

	const id = writer.relate(main, name, NOTES_MASTER)
	const p = r.namespaces.prefixFor(root, P_MAIN) ?? "p"
	const rel = r.namespaces.prefixFor(root, URIS["r"] ?? "") ?? "r"
	const q = (local: string): string => (p === "" ? local : `${p}:${local}`)
	const markup = `<${q("notesMasterIdLst")}><${q("notesMasterId")} ${rel}:id="${escapeAttribute(id)}"/></${q("notesMasterIdLst")}>`
	const after = r.child(root, G.P, "sldMasterIdLst")

	if (after < 0) return refused("malformed", "presentation.xml has no p:sldMasterIdLst")
	if (r.namespaces.prefixFor(root, URIS["r"] ?? "") === undefined)
		return refused("unsupported", "presentation.xml declares no relationships prefix")

	writer.editor(main).insertAfter(after, markup)

	return undefined
}

// A deck whose only notes master was the session's: none of its nodes is a notes master read from the file.
function sessionMasterless(deck: Deck): boolean {
	for (const node of deck.nodes.values()) if (node.kind === "notesMaster" && node.src !== undefined) return false

	return true
}
