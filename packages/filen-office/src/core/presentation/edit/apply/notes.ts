import { DEFAULT_PRESENTATION_BUDGETS } from "../../budget"
import { reviewFacts } from "../../comments"
import { refused, type Deck, type Refused, type SlideNode, type SlideRef, type TextBody } from "../../model"
import { defaultNotesMaster, markMadeNotesPart, newNotesSlide, notesBody, notesBoxes } from "../../notes"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import type { NotesOp } from "../ops"
import { cloneModel } from "../changes"
import { sourceReading } from "./heldPage"
import { applyText } from "./text"

// setNotes: a slide's speaker notes. On a slide with a notes slide it is the text family's setText on the notes
// placeholder (its inverse holds the body's source bytes the way a shape's does). On a slide without one it makes the
// notes slide (core/presentation/notes.ts), and the deck's notes master first when the deck has none (pptx: ours);
// the writer adds their parts (emit/notes.ts). Its inverse removes what it made. The op as applied makes the same refs
// and part names again on a redo (MADE), so later steps naming the notes body still find it; the removing inverse is
// marked by the session (REMOVES), never by a field of the op's contract: it never leaves the worker.

const MADE = new WeakMap<
	NotesOp,
	{ readonly notes: SlideRef; readonly part: string; readonly master?: { readonly ref: SlideRef; readonly part: string } }
>()
const REMOVES = new WeakSet<NotesOp>()

const BUDGETS = DEFAULT_PRESENTATION_BUDGETS

function checkBody(body: TextBody): Refused | undefined {
	let runs = 0

	for (const paragraph of body.paragraphs) {
		runs += paragraph.runs.length

		if (runs > BUDGETS.runsPerBody) return refused("tooLarge", `${String(runs)} runs in one body`)

		for (const run of paragraph.runs) {
			if (run.kind === "opaque") return refused("unsupported", "content kept as source in new notes")
			if (run.kind === "br") continue

			for (let index = 0; index < run.text.length; index++) {
				const code = run.text.charCodeAt(index)

				if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff)
					return refused("malformed", "text holds a character XML cannot")
			}
		}
	}

	return undefined
}

function partTaken(deck: Deck, part: string): boolean {
	const key = part.toLowerCase()

	if (reviewFacts(deck)?.takenParts.has(key.replace(/^\//u, "")) === true) return true

	for (const node of deck.nodes.values()) if (node.part.toLowerCase() === key) return true

	return false
}

function freeName(deck: Deck, prefix: string): string {
	for (let n = 1; ; n++) {
		const name = `${prefix}${String(n)}.xml`

		if (!partTaken(deck, name)) return name
	}
}

// A session-made notes master no notes slide uses any more goes with the last one.
function dropUnusedMaster(deck: Deck, masterRef: SlideRef | undefined): void {
	if (masterRef === undefined || deck.notesMaster !== masterRef) return

	const master = deck.nodes.get(masterRef)

	if (master === undefined || master.src !== undefined) return

	for (const node of deck.nodes.values()) if (node.kind === "notes" && node.parent === masterRef) return

	deck.nodes.delete(masterRef)
	delete deck.notesMaster
}

function remove(deck: Deck, op: NotesOp, slide: SlideNode): ApplyResult<NotesOp> {
	const notes = slide.notes === undefined ? undefined : deck.nodes.get(slide.notes)

	if (notes === undefined) return { kind: "applied", inverse: { ops: [], bytes: 0 }, op }

	const master = notes.parent === undefined ? undefined : deck.nodes.get(notes.parent)

	deck.nodes.delete(notes.ref)
	delete slide.notes
	slide.revision++
	dropUnusedMaster(deck, notes.parent)

	// Undone, the removal is the op that made them, as it was applied (its refs and names held in MADE).
	const back: NotesOp = { family: "notes", kind: "setNotes", slide: op.slide, body: cloneModel(notesBody(notes)?.text ?? EMPTY) }
	const dropped = master !== undefined && !deck.nodes.has(master.ref)

	MADE.set(back, { notes: notes.ref, part: notes.part, ...(dropped ? { master: { ref: master.ref, part: master.part } } : {}) })

	return { kind: "applied", inverse: { ops: [back], bytes: 128 }, op }
}

const EMPTY: TextBody = { bodyPr: {}, paragraphs: [] }

function create(deck: Deck, op: NotesOp, slide: SlideNode, context: ApplyContext): ApplyResult<NotesOp> {
	const checked = checkBody(op.body)

	if (checked !== undefined) return checked

	const odp = deck.format === "odp"
	const made = MADE.get(op)
	let masterRef = deck.notesMaster
	let masterPart: string | undefined

	if (masterRef === undefined && !odp) {
		masterRef = made?.master?.ref ?? context.newSlideRef()
		masterPart = made?.master?.part ?? `/${freeName(deck, "ppt/notesMasters/notesMaster")}`

		const theme = deck.masters.map(ref => deck.nodes.get(ref)?.theme).find(each => each !== undefined)

		deck.nodes.set(masterRef, defaultNotesMaster(deck, masterRef, masterPart, theme))
		deck.notesMaster = masterRef
		markMadeNotesPart(deck, masterPart)
	}

	const reading = sourceReading(context)
	const ref = made?.notes ?? context.newSlideRef()
	const part =
		made?.part ??
		(odp ? `/content.xml#${String(ref)}` : (reading?.newPart("notesSlide") ?? `/${freeName(deck, "ppt/notesSlides/notesSlide")}`))
	const master = masterRef === undefined ? undefined : deck.nodes.get(masterRef)
	const notes = newNotesSlide(ref, part, masterRef, cloneModel(op.body), odp ? notesBoxes(deck, master) : undefined)

	// Empty notes hold no body text, as setText leaves a body it empties (apply/text.ts): one model, one written part.
	if (op.body.paragraphs.length === 0 && Object.keys(op.body.bodyPr).length === 0 && op.body.lstStyle === undefined)
		for (const shape of notes.shapes) if (shape.ph?.type === "body") delete shape.text

	deck.nodes.set(ref, notes)
	slide.notes = ref
	if (!odp) markMadeNotesPart(deck, part)
	slide.revision++

	MADE.set(op, {
		notes: ref,
		part,
		...(masterPart === undefined || masterRef === undefined ? {} : { master: { ref: masterRef, part: masterPart } })
	})

	const inverse: NotesOp = { family: "notes", kind: "setNotes", slide: op.slide, body: EMPTY }

	REMOVES.add(inverse)

	return { kind: "applied", inverse: { ops: [inverse], bytes: 128 }, op }
}

export const applyNotes: ApplyFamily<NotesOp> = {
	apply(deck, op, context) {
		const slide = deck.nodes.get(op.slide)

		if (slide === undefined) return refused("notFound", `slide ${String(op.slide)} is not parsed`)
		if (slide.kind !== "slide") return refused("unsupported", "notes of a node that is not a slide")
		if (REMOVES.has(op)) return remove(deck, op, slide)

		const notes = slide.notes === undefined ? undefined : deck.nodes.get(slide.notes)

		if (slide.notes !== undefined && notes === undefined)
			return refused("notFound", `notes of slide ${String(op.slide)} are not parsed`)
		if (notes === undefined) return create(deck, op, slide, context)

		const body = notesBody(notes)

		if (body === undefined) return refused("unsupported", "a notes slide without a notes placeholder")

		const result = applyText.apply(
			deck,
			{
				family: "text",
				kind: "setText",
				target: { slide: notes.ref, id: body.id },
				body: op.body,
				...(op.burst === undefined ? {} : { burst: op.burst }),
				...(op.raw === undefined ? {} : { raw: op.raw })
			},
			context
		)

		return result.kind === "refused" ? result : { kind: "applied", inverse: result.inverse, op }
	},
	touches(op) {
		const touches: Touch[] = [{ kind: "slide", slide: op.slide, dirt: { kind: "slidePart", part: "notes" } }]
		const made = MADE.get(op)

		if (made !== undefined) touches.push({ kind: "slide", slide: made.notes, dirt: { kind: "node" } })

		return touches
	}
}
