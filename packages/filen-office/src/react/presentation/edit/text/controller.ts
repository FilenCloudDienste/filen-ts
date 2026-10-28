import type { Node } from "prosemirror-model"
import { EditorState, TextSelection, type Selection, type Transaction } from "prosemirror-state"
import { Mapping, ReplaceStep, Transform, type Step } from "prosemirror-transform"
import type { TextBodyProps } from "../../../../core/drawingml/index"
import {
	selectionParaProps,
	selectionRunProps,
	type TextCommand,
	type TextDefaults
} from "../../../../core/presentation/edit/commands/text"
import {
	PresentationError,
	type ParaProps,
	type PresentationRefusal,
	type RunProps,
	type ShapeRef,
	type TextBody
} from "../../../../core/presentation/model"
import type { TextPage, TextSeed } from "../../../../core/presentation/output"
import { editableParagraphs } from "../../../../core/presentation/text/editable"
import { bodyToDoc, docToBody, presentationTextSchema } from "../../../../core/presentation/text/schema"
import type { MeasureCache } from "../../../../core/text/index"
import type { DeckOp } from "../../../../core/presentation/edit/ops"
import type { CommandResult, PresentationSessionApi } from "../../../../dom/presentation/protocol"
import { TextMailbox } from "../../../../dom/presentation/textMailbox"
import { LayoutMap } from "./layoutMap"

// The body being edited, on the page. The page holds a ProseMirror state for input, composition and selection only;
// every transaction's body is laid out by the worker (layoutText, the session's one measuring realm) and painted from
// the TextPage it answers, at most one request in flight (the newest body goes next). Its setText reaches the
// worker's history at a transaction boundary: 150 ms after the last change, on blur, and always before any other
// command (flush). Typing coalesces into one undo step as prosemirror-history groups it in the docx editor: adjacent
// changes less than 500 ms apart; a formatting command, a paste or an undo starts the next. The view keeps no
// history: undo and redo are the worker's, and a step that touched this body reseeds the view.
//
// While a step, a command on this body or a resync is on its way, nothing is committed: changes typed meanwhile are
// held (applied to the view, logged as steps) and, once the answer's seed arrives, rebased onto it the way
// prosemirror-collab rebases local steps over remote ones, then committed. Every reseed starts a new layout
// generation; a layout answered for an older one is never painted.

export const COMMIT_IDLE_MS = 150
// prosemirror-history's newGroupDelay (its default, which the docx editor uses).
export const TYPING_GROUP_MS = 500

// Frames the mailbox is read for one layout (about 2 s at 60 Hz); after that only the posted answer is awaited.
export const MAX_MAILBOX_FRAMES = 120
// How long the first frame after a change waits for an answer the worker is still writing (its median is under 1 ms):
// spinning on shared memory here paints the change in this frame instead of the next.
export const MAILBOX_SPIN_MS = 3
const MAX_SPIN_READS = 200_000
// A layout unanswered this long is reported (a worker that died without an error event never answers).
export const LAYOUT_STALL_MS = 10_000

// Burst ids are unique on the page: a body opened again never coalesces into a step of an earlier opening.
let nextBurst = 1

interface LoggedStep {
	readonly step: Step
	readonly inverted: Step
	// The document the step applies to.
	readonly before: Node
}

type LayoutAnswer = Awaited<ReturnType<PresentationSessionApi["layoutText"]>>

interface Hold {
	// The document the worker's answer replaces: changes logged after it are replayed on the answer's seed.
	base: Node
	readonly done: Promise<void>
	readonly release: () => void
}

export interface TextEditFormat {
	readonly run: Partial<RunProps>
	readonly paragraph: Partial<ParaProps>
	readonly bodyPr: Partial<TextBodyProps>
}

export interface TextEditListener {
	// Something drawn changed: the page, the selection or the format.
	(): void
}

// Paragraph defaults by level from a seed's resolved paragraphs (one per paragraph the editor shows, so a body
// without paragraphs has its empty one's): per level, the resolved props of the paragraph at that level that writes
// the fewest of its own (closest to the chain); levels no paragraph uses take the nearest lower one's.
export function defaultsOf(seed: TextSeed): TextDefaults {
	const byLevel: (ParaProps | undefined)[] = []
	const owned: number[] = []

	editableParagraphs(seed.body).forEach((paragraph, index) => {
		const resolved = seed.resolved[index]

		if (resolved === undefined) return

		const level = Math.max(0, Math.min(8, paragraph.pPr.lvl ?? 0))
		const own = Object.keys(paragraph.pPr).length

		if (byLevel[level] === undefined || own < (owned[level] ?? Infinity)) {
			byLevel[level] = resolved.pPr
			owned[level] = own
		}
	})

	return {
		paragraph: level => {
			for (let at = Math.max(0, Math.min(8, level)); at >= 0; at--) {
				const props = byLevel[at]

				if (props !== undefined) return props
			}

			return byLevel.find(props => props !== undefined) ?? {}
		}
	}
}

export class TextEditController {
	readonly shape: ShapeRef
	state: EditorState
	page: TextPage
	map: LayoutMap
	// The document `map` was built over (the state may be ahead of it while a layout is in flight).
	mapDoc: Node
	matrix: readonly number[]
	defaults: TextDefaults
	// Where Up and Down aim (TextPage px), kept across vertical moves.
	goalX: number | undefined
	closed = false
	private readonly session: PresentationSessionApi
	private readonly cache: MeasureCache
	private seed: TextBody
	private origins: readonly Node[]
	private readonly listeners = new Set<TextEditListener>()
	private inFlight = false
	// What `map` was laid out from (a bodyPr change lays out the same document again).
	private mapBodyPr: Partial<TextBodyProps>
	private generation = 0
	private committedDoc: Node
	private committedBodyPr: Partial<TextBodyProps>
	private commitTimer: ReturnType<typeof setTimeout> | undefined
	private commits: Promise<void> = Promise.resolve()
	private sending = 0
	// Steps, holds and commands on this body, one at a time.
	private steps: Promise<unknown> = Promise.resolve()
	private hold: Hold | undefined
	// Document steps since the oldest document a refused commit or a hold may have to rebase from.
	private log: LoggedStep[] = []
	private burst = 0
	private burstOpen = false
	private lastTypingAt = 0
	// Where the last typing changed the document (prosemirror-history's adjacency), in the current document.
	private typingRanges: number[] | undefined
	private formatCache: TextEditFormat | undefined
	private readonly onRefused: (reason: PresentationRefusal) => void
	// Where layouts are read in the frame they arrive before (a cross-origin isolated page); undefined elsewhere.
	private readonly mailbox = TextMailbox.create()

	constructor(session: PresentationSessionApi, seed: TextSeed, cache: MeasureCache, onRefused: (reason: PresentationRefusal) => void) {
		this.session = session
		this.cache = cache
		this.shape = seed.shape
		this.onRefused = onRefused

		const { doc, origins } = bodyToDoc(seed.body)

		this.seed = seed.body
		this.origins = origins
		this.state = EditorState.create({ doc, schema: presentationTextSchema, selection: TextSelection.atEnd(doc) })
		this.page = seed.page
		this.map = new LayoutMap(doc, docToBody(doc, seed.body, origins), seed.layout, cache)
		this.mapDoc = doc
		this.mapBodyPr = seed.body.bodyPr
		this.matrix = seed.matrix
		this.defaults = defaultsOf(seed)
		this.committedDoc = doc
		this.committedBodyPr = seed.body.bodyPr
	}

	subscribe(listener: TextEditListener): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	private notify(): void {
		this.formatCache = undefined

		for (const listener of this.listeners) listener()
	}

	get body(): TextBody {
		return docToBody(this.state.doc, this.seed, this.origins)
	}

	get bodyPr(): Partial<TextBodyProps> {
		return this.seed.bodyPr
	}

	// Changes the worker does not hold yet: typed but not sent, sent but not answered, or held behind a step.
	get pending(): boolean {
		return this.dirty || this.sending > 0 || this.hold !== undefined
	}

	private get dirty(): boolean {
		return this.state.doc !== this.committedDoc || this.seed.bodyPr !== this.committedBodyPr
	}

	// Whether the paragraph at the caret runs right to left: its own a:pPr rtl, else its level's along the body's chain
	// (a master's list style often sets it for Arabic and Hebrew decks).
	get rtl(): boolean {
		const pPr = this.state.selection.$head.parent.attrs["pPr"] as ParaProps | undefined

		return (pPr?.rtl ?? this.defaults.paragraph(pPr?.lvl ?? 0).rtl) === true
	}

	// What the ribbon shows for the selection.
	format(): TextEditFormat {
		this.formatCache ??= {
			run: selectionRunProps(this.state, this.defaults),
			paragraph: selectionParaProps(this.state, this.defaults),
			bodyPr: this.seed.bodyPr
		}

		return this.formatCache
	}

	// A transaction from the input sink or a command. `typing` (inserting and deleting text) continues the current
	// burst while it is adjacent to the last typing and less than TYPING_GROUP_MS after it; anything else starts the
	// next, with the changes before it sent as their own step.
	dispatch(tr: Transaction, typing = false): void {
		if (this.closed) return

		if (!tr.docChanged) {
			this.state = this.state.apply(tr)
			this.notify()

			return
		}

		const now = Date.now()
		const continues =
			typing &&
			this.burstOpen &&
			now - this.lastTypingAt <= TYPING_GROUP_MS &&
			this.typingRanges !== undefined &&
			adjacent(tr, this.typingRanges)

		if (!continues) {
			if (this.dirty && this.hold === undefined) void this.flush()

			this.burst = nextBurst++
			this.burstOpen = typing
		}

		for (let index = 0; index < tr.steps.length; index++) {
			const step = tr.steps[index] as Step
			const before = tr.docs[index] as Node

			this.log.push({ step, inverted: step.invert(before), before })
		}

		this.state = this.state.apply(tr)
		this.typingRanges = typing ? changedRanges(tr) : undefined

		if (typing) this.lastTypingAt = now

		this.requestLayout()

		if (this.hold === undefined) this.scheduleCommit()

		this.notify()
	}

	// A command over the body (the ribbon's or the keyboard's); false when it does not apply.
	run(command: TextCommand, typing = false): boolean {
		return command(this.state, tr => {
			this.dispatch(tr, typing)
		})
	}

	setSelection(anchor: number, head: number = anchor): void {
		const doc = this.state.doc
		const clamp = (pos: number): number => Math.max(0, Math.min(doc.content.size, pos))

		this.dispatch(this.state.tr.setSelection(TextSelection.between(doc.resolve(clamp(anchor)), doc.resolve(clamp(head)))))
	}

	// a:bodyPr of the body (anchoring, columns, direction, autofit…), kept outside the document.
	setBodyPr(patch: Partial<TextBodyProps>): void {
		if (this.closed) return
		if (this.dirty && this.hold === undefined) void this.flush()

		this.seed = { ...this.seed, bodyPr: { ...this.seed.bodyPr, ...patch } }
		this.burst = nextBurst++
		this.burstOpen = false
		this.typingRanges = undefined
		this.requestLayout()

		if (this.hold === undefined) this.scheduleCommit()

		this.notify()
	}

	private requestLayout(): void {
		if (this.inFlight) return

		const doc = this.state.doc
		const bodyPr = this.seed.bodyPr
		const body = docToBody(doc, this.seed, this.origins)
		const generation = this.generation
		const ticket = this.mailbox?.ticket()
		let answered = false

		const answer = (result: LayoutAnswer): void => {
			if (answered) return

			answered = true
			clearTimeout(stall)
			this.inFlight = false

			if (this.closed) return

			// A layout of a document a reseed replaced is never painted.
			if (generation === this.generation) {
				this.page = result.page
				this.map = new LayoutMap(doc, body, result.layout, this.cache)
				this.mapDoc = doc
				this.mapBodyPr = bodyPr
				this.notify()
			}

			if (this.mapDoc !== this.state.doc || this.mapBodyPr !== this.seed.bodyPr) this.requestLayout()
		}

		const fail = (reason: PresentationRefusal): void => {
			if (answered) return

			answered = true
			clearTimeout(stall)
			this.inFlight = false

			if (!this.closed) this.onRefused(reason)
		}
		// The next change asks again once this one is given up.
		const stall = setTimeout(() => {
			fail("failed")
		}, LAYOUT_STALL_MS)

		this.inFlight = true
		this.session.layoutText(this.shape, body, this.state.selection.head, ticket).then(answer, (error: unknown) => {
			fail(error instanceof PresentationError ? error.reason : "failed")
		})

		if (ticket !== undefined) this.watch(ticket.id, answer, () => answered)
	}

	// Reads the answer from the mailbox at the start of each frame until it is there (or posted only): painted in the
	// frame it arrived before, where the posted answer would wait for the next one.
	private watch(id: number, answer: (result: LayoutAnswer) => void, done: () => boolean): void {
		const mailbox = this.mailbox
		const frame: unknown = Reflect.get(globalThis, "requestAnimationFrame")

		if (mailbox === undefined || typeof frame !== "function") return

		let frames = 0
		const tick = (): void => {
			// A closed session, or a worker that did not write in time: the posted answer (or its failure) decides.
			if (done() || this.closed || Reflect.get(this.session, "closed") === true) return

			let taken = mailbox.take(id)

			if (taken === undefined && frames === 0) {
				const until = performance.now() + MAILBOX_SPIN_MS

				// Bounded by count too: a clock that does not move (a frozen or faked one) never ends a spin.
				for (let reads = 0; taken === undefined && reads < MAX_SPIN_READS && performance.now() < until; reads++)
					taken = mailbox.take(id)
			}

			if (taken === undefined) {
				if (++frames < MAX_MAILBOX_FRAMES) (frame as (callback: () => void) => number)(tick)
			} else if (taken !== "posted") answer(taken.value as LayoutAnswer)
		}

		;(frame as (callback: () => void) => number)(tick)
	}

	private scheduleCommit(): void {
		if (this.commitTimer !== undefined) clearTimeout(this.commitTimer)

		this.commitTimer = setTimeout(() => {
			this.commitTimer = undefined
			void this.flush()
		}, COMMIT_IDLE_MS)
	}

	// Sends the body's setText now when it changed since the last one; resolves once the worker has it. Every command
	// the page sends while a body is open waits for this first; while a step is on its way, it waits for that too.
	flush(): Promise<void> {
		if (this.commitTimer !== undefined) {
			clearTimeout(this.commitTimer)
			this.commitTimer = undefined
		}

		const hold = this.hold

		if (hold !== undefined) return hold.done.then(() => this.flush())
		if (!this.dirty) return this.commits

		const doc = this.state.doc
		const bodyPr = this.seed.bodyPr
		const body = docToBody(doc, this.seed, this.origins)
		const burst = this.burst
		const generation = this.generation

		// Steps before the document sent are needed only by commits still on their way.
		if (this.sending === 0) this.log = []

		this.committedDoc = doc
		this.committedBodyPr = bodyPr
		this.sending++
		this.commits = this.commits.then(async () => {
			// A resync after a refused commit replaced what this body was built on: its changes come back rebased.
			const result: CommandResult =
				generation === this.generation
					? await this.session
							.command({ family: "text", kind: "setText", target: this.shape, body, burst })
							.catch((error: unknown): CommandResult => ({
								ok: false,
								refusal: error instanceof PresentationError ? error.reason : "failed"
							}))
					: { ok: true, revision: 0, dirty: true }

			this.sending--

			if (!result.ok) {
				this.onRefused(result.refusal)
				await this.resync(doc)
			}

			this.notify()
		})

		return this.commits
	}

	// The view brought back to the worker's body after a refused commit of `sent`; what was typed after it is kept.
	private async resync(sent: Node): Promise<void> {
		const outer = this.hold

		if (outer !== undefined) outer.base = sent

		const hold = outer ?? this.holdFrom(sent)

		try {
			this.reseed(await this.session.textSeed(this.shape))
		} catch (error) {
			this.onRefused(error instanceof PresentationError ? error.reason : "failed")
		} finally {
			if (outer === undefined) this.release(hold)
		}
	}

	private holdFrom(base: Node): Hold {
		let release = (): void => undefined
		const done = new Promise<void>(resolve => {
			release = resolve
		})
		const hold: Hold = { base, done, release }

		if (this.commitTimer !== undefined) {
			clearTimeout(this.commitTimer)
			this.commitTimer = undefined
		}

		this.hold = hold

		return hold
	}

	private release(hold: Hold): void {
		if (this.hold === hold) this.hold = undefined

		hold.release()

		if (!this.closed && this.dirty) this.scheduleCommit()

		this.notify()
	}

	// A seed from the worker (an undo or redo that touched this body, a command on it, a resync) replaces the
	// document. Changes held since the hold's base are replayed on it; the caret stays where it maps to.
	reseed(seed: TextSeed): void {
		if (this.closed) return

		const { doc: seeded, origins } = bodyToDoc(seed.body)
		const base = this.hold?.base
		const from = base === undefined ? -1 : this.log.findIndex(entry => entry.before === base)
		const held = base === undefined || base === this.state.doc ? [] : from < 0 ? [] : this.log.slice(from)
		let doc = seeded
		let selection: Selection

		this.generation++

		if (held.length === 0) {
			const head = this.state.selection.head

			this.log = []
			selection = TextSelection.near(seeded.resolve(Math.max(0, Math.min(seeded.content.size, head))))
		} else {
			const rebased = rebase(held, base as Node, seeded)
			const map = (pos: number): number => Math.max(0, Math.min(rebased.doc.content.size, rebased.mapping.map(pos)))

			doc = rebased.doc
			this.log = rebased.steps
			selection = TextSelection.between(doc.resolve(map(this.state.selection.anchor)), doc.resolve(map(this.state.selection.head)))
		}

		if (this.hold !== undefined) this.hold.base = seeded

		this.seed = seed.body
		this.origins = origins
		this.state = EditorState.create({ doc, schema: presentationTextSchema, selection })
		this.page = seed.page
		this.map = new LayoutMap(seeded, docToBody(seeded, seed.body, origins), seed.layout, this.cache)
		this.mapDoc = seeded
		this.mapBodyPr = seed.body.bodyPr
		this.matrix = seed.matrix
		this.defaults = defaultsOf(seed)
		// The worker holds the seed's body; held changes on it are this view's to send.
		this.committedDoc = seeded
		this.committedBodyPr = seed.body.bodyPr
		this.burst = nextBurst++
		this.burstOpen = false
		this.typingRanges = undefined

		if (doc !== seeded) this.requestLayout()

		this.notify()
	}

	// Runs `send` (an undo, a redo, a command on this body) after this body's pending setText, holding changes typed
	// until its answer; a seed in the answer reseeds the view.
	private stepWith(send: () => Promise<CommandResult>): Promise<CommandResult> {
		const run = async (): Promise<CommandResult> => {
			if (this.closed) return { ok: false, refusal: "closed" }

			const sent = this.flush()
			const hold = this.holdFrom(this.state.doc)

			try {
				await sent

				const result = await send().catch((error: unknown): CommandResult => ({
					ok: false,
					refusal: error instanceof PresentationError ? error.reason : "failed"
				}))

				if (result.ok && result.seed !== undefined) this.reseed(result.seed)
				else if (!result.ok) this.onRefused(result.refusal)

				return result
			} finally {
				this.release(hold)
			}
		}
		const next = this.steps.then(run, run)

		this.steps = next

		return next
	}

	// Mod+Z and Mod+Y in the body: the worker's history, after this body's pending setText.
	step(direction: "undo" | "redo"): Promise<CommandResult> {
		return this.stepWith(() => (direction === "undo" ? this.session.undo(this.shape) : this.session.redo(this.shape)))
	}

	undo(): Promise<CommandResult> {
		return this.step("undo")
	}

	redo(): Promise<CommandResult> {
		return this.step("redo")
	}

	// A command the page sends while this body is open (find's replace, a ribbon command on its shape): after this
	// body's pending setText, naming the body so the answer reseeds it when the command changed it.
	command(op: DeckOp): Promise<CommandResult> {
		return this.stepWith(() => this.session.command(op, this.shape))
	}

	// Leaves the body: its last setText sent.
	async close(): Promise<void> {
		if (this.closed) return

		await this.steps.catch(() => undefined)
		await this.flush()
		this.closed = true
		this.listeners.clear()
	}
}

// The ranges a transaction changed, in its resulting document (prosemirror-history's rangesFor of the last map).
function changedRanges(tr: Transaction): number[] {
	const ranges: number[] = []
	const maps = tr.mapping.maps

	for (let index = maps.length - 1; index >= 0 && ranges.length === 0; index--) {
		maps[index]?.forEach((_oldStart, _oldEnd, start, end) => {
			ranges.push(start, end)
		})
	}

	return ranges
}

// Whether a transaction's first change touches the ranges the last typing changed (prosemirror-history isAdjacentTo).
function adjacent(tr: Transaction, ranges: readonly number[]): boolean {
	let touches = false

	tr.mapping.maps[0]?.forEach((start, end) => {
		for (let index = 0; index < ranges.length; index += 2) {
			if (start <= (ranges[index + 1] ?? -1) && end >= (ranges[index] ?? 0)) touches = true
		}
	})

	return touches
}

// The change from `base` to `seeded` as one step (the shortest replaced range), for mapping held steps across it.
function diffStep(base: Node, seeded: Node): Step | undefined {
	const start = base.content.findDiffStart(seeded.content)

	if (start === null) return undefined

	const end = base.content.findDiffEnd(seeded.content) ?? { a: base.content.size, b: seeded.content.size }
	let endA = end.a
	let endB = end.b
	const overlap = start - Math.min(endA, endB)

	if (overlap > 0) {
		endA += overlap
		endB += overlap
	}

	return new ReplaceStep(start, endA, seeded.slice(start, endB))
}

// Steps logged after `base` replayed on `seeded` (prosemirror-collab's rebaseSteps): each mapped back through the
// inverses of the ones before it, across the base-to-seed change, and forward through the ones already replayed. A
// step that no longer applies is dropped. The mapping takes positions of the current document to the result.
function rebase(held: readonly LoggedStep[], base: Node, seeded: Node): { doc: Node; mapping: Mapping; steps: LoggedStep[] } {
	const mapping = new Mapping()

	for (let index = held.length - 1; index >= 0; index--) mapping.appendMap((held[index] as LoggedStep).inverted.getMap())

	const over = diffStep(base, seeded)

	if (over !== undefined) mapping.appendMap(over.getMap())

	const out = new Transform(seeded)
	const steps: LoggedStep[] = []
	let mapFrom = held.length

	for (const entry of held) {
		const mapped = entry.step.map(mapping.slice(mapFrom))

		mapFrom--

		if (mapped === null) continue

		const before = out.doc

		if (out.maybeStep(mapped).failed) continue

		mapping.appendMap(mapped.getMap(), mapFrom)
		steps.push({ step: mapped, inverted: mapped.invert(before), before })
	}

	return { doc: out.doc, mapping, steps }
}
