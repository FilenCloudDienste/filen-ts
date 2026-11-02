import { describe, expect, it } from "vitest"
import type { Touch } from "../core/presentation/edit/apply"
import { DeckHistory, touchKey, type Fingerprint, type HistoryLimits } from "../core/presentation/edit/history"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type SlideNode, type SlideRef } from "../core/presentation/model"
import { editCapability, sessionEdits } from "../dom/presentation/engine/edit"
import { review } from "../dom/presentation/engine/review"
import { driveSession } from "./odpWriteDrive"
import { buildPptx } from "./pptxFixtures"
import { editDeckOptions } from "./presentationEditFixtures"

// Taking back the last step (notes started and left with nothing typed): the deck and the history are as they were
// before it, undo and redo stacks included, and it leaves no redo step.

const SLIDE = slideRef(1)

function touch(id: number): Touch {
	return { kind: "shape", slide: SLIDE, shape: id, dirt: { kind: "xfrm" } }
}

// A toy model (key → value) whose steps set one key and whose inverses set it back.
class Toy {
	readonly values = new Map<string, string>()
	readonly history: DeckHistory

	constructor(limits?: HistoryLimits) {
		this.history = new DeckHistory(key => this.fingerprint(key), limits)
	}

	fingerprint(key: string): Fingerprint {
		const value = this.values.get(key)

		return value === undefined ? { digest: "", exists: false } : { digest: value, exists: true }
	}

	set(id: number, value: string | undefined, provisional = false): number {
		const key = touchKey(touch(id))
		const before = new Map([[key, this.fingerprint(key)]])
		const prior = this.values.get(key)
		const alt = (descr: string | undefined) => (descr === undefined ? undefined : { descr })

		if (value === undefined) this.values.delete(key)
		else this.values.set(key, value)

		this.history.push(
			{
				op: { family: "shape", kind: "setAlt", target: { slide: SLIDE, id }, alt: alt(value) } as DeckOp,
				inverse: { ops: [{ family: "shape", kind: "setAlt", target: { slide: SLIDE, id }, alt: alt(prior) } as DeckOp], bytes: 0 },
				touches: [touch(id)],
				before,
				after: new Map([[key, this.fingerprint(key)]]),
				bytes: 10,
				burst: undefined
			},
			{ provisional }
		)

		return this.history.revision
	}

	private replay(op: DeckOp | undefined): void {
		if (op?.family !== "shape" || op.kind !== "setAlt") return

		const key = touchKey(touch(op.target.id))

		if (op.alt?.descr === undefined) this.values.delete(key)
		else this.values.set(key, op.alt.descr)
	}

	undo(): void {
		for (const op of this.history.peekUndo()?.inverse.ops ?? []) this.replay(op)

		this.history.undone()
	}

	redo(): void {
		this.replay(this.history.peekRedo()?.op)
		this.history.redone()
	}

	retract(revision: number): boolean {
		const step = this.history.retractable(revision)

		if (step === undefined) return false

		for (const op of step.inverse.ops) this.replay(op)

		this.history.retract()

		return true
	}

	get shape(): { depth: { undo: number; redo: number }; dirty: boolean; atSaved: boolean; values: [string, string][] } {
		return { depth: this.history.depth, dirty: this.history.dirty, atSaved: this.history.atSaved, values: [...this.values] }
	}
}

describe("retracting the last step", () => {
	it("leaves the undo and redo stacks, the dirty flag and the model as they were before it", () => {
		const toy = new Toy()

		toy.set(1, "a")
		toy.set(2, "b")
		toy.undo()

		const before = toy.shape
		const revision = toy.set(3, "c")

		expect(toy.history.depth).toEqual({ undo: 2, redo: 0 })
		expect(toy.retract(revision)).toBe(true)
		expect(toy.shape).toEqual(before)

		// The redo step the push had discarded comes back, and is the one redone.
		toy.redo()
		expect(toy.values.get(touchKey(touch(2)))).toBe("b")
		expect(toy.history.depth).toEqual({ undo: 2, redo: 0 })
	})

	it("is clean again at the saved state, and puts back the oldest steps the push trimmed", () => {
		const toy = new Toy({ maxSteps: 2, maxBytes: 1_000_000 })

		toy.set(1, "a")
		toy.set(2, "b")
		toy.history.commit(toy.history.savePoint())

		const before = toy.shape
		const revision = toy.set(3, "c")

		expect(toy.history.depth).toEqual({ undo: 2, redo: 0 })
		expect(toy.retract(revision)).toBe(true)
		expect(toy.shape).toEqual(before)
		expect(before.dirty).toBe(false)
		toy.undo()
		toy.undo()
		expect(toy.values.size).toBe(0)
	})

	it("after a save landed on the step, the deck is dirty against it and the redo stack is still back", () => {
		const toy = new Toy()

		toy.set(1, "a")
		toy.undo()

		const revision = toy.set(2, "b")

		toy.history.commit(toy.history.savePoint())
		expect(toy.history.dirty).toBe(false)
		expect(toy.retract(revision)).toBe(true)
		expect(toy.history.depth).toEqual({ undo: 0, redo: 1 })
		expect(toy.history.dirty).toBe(true)
		expect(toy.history.atSaved).toBe(false)
	})

	it("a provisional step on a state that matches the saved one reads clean, wherever that state sits in the timeline", () => {
		const toy = new Toy()

		toy.set(1, "a")

		const revision = toy.set(2, "b")

		toy.history.commit(toy.history.savePoint())
		expect(toy.retract(revision)).toBe(true)
		expect(toy.history.dirty).toBe(true)
		// The same change made again: the file's state, one step lower than the save left it.
		toy.set(2, "b")
		expect(toy.history.dirty).toBe(false)
		toy.set(3, "notes", true)
		expect(toy.history.dirty).toBe(false)
		expect(toy.history.dirtyBytes).toBe(0)
	})

	it("a provisional step on a state that differs from the saved one reads dirty", () => {
		const toy = new Toy()

		toy.set(1, "a")
		toy.history.commit(toy.history.savePoint())
		toy.set(1, "b")
		toy.set(3, "notes", true)
		expect(toy.history.dirty).toBe(true)
	})

	it("a provisional step over a key an earlier step changed since the save reads dirty", () => {
		const toy = new Toy()

		toy.history.commit(toy.history.savePoint())
		toy.set(3, "x")
		toy.set(3, "notes", true)
		expect(toy.history.dirty).toBe(true)
	})

	it("is refused once anything was done, undone or redone after the step", () => {
		const toy = new Toy()
		const first = toy.set(1, "a")

		toy.set(2, "b")
		expect(toy.retract(first)).toBe(false)

		const second = toy.history.revision

		toy.undo()
		expect(toy.retract(second)).toBe(false)
		toy.redo()
		expect(toy.retract(toy.history.revision)).toBe(false)
	})
})

describe("retract in the edit engine", () => {
	const lines = (...texts: string[]) => ({
		bodyPr: {},
		paragraphs: texts.map(text => ({ pPr: {}, runs: [{ kind: "r" as const, text, rPr: {} }] }))
	})

	it("notes started and taken back leave the deck, its history and its redo stack as before", async () => {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const [first, second] = s.session.deck.slides as SlideRef[]

		if (first === undefined || second === undefined) throw new Error("two slides")

		const history = sessionEdits(s.session).history

		// A redo stack the user has: notes written on the first slide and undone.
		expect((await s.command({ family: "notes", kind: "setNotes", slide: first, body: lines("Keep") })).ok).toBe(true)
		expect((await s.undo()).ok).toBe(true)

		const before = { depth: history.depth, dirty: history.dirty, notes: (await review(s.context, second, { comments: false })).notes }
		const started = await s.command({ family: "notes", kind: "setNotes", slide: second, body: lines() })

		if (!started.ok) throw new Error("setNotes refused")

		expect((await review(s.context, second, { comments: false })).notes).toBeDefined()

		const taken = await editCapability.retract(s.context, started.revision)

		expect(taken.ok).toBe(true)
		expect({ depth: history.depth, dirty: history.dirty, notes: (await review(s.context, second, { comments: false })).notes }).toEqual(
			before
		)

		// The redo stack survived: redo writes the first slide's notes again.
		expect((await s.redo()).ok).toBe(true)
		expect((await review(s.context, first, { comments: false })).notesText).toBe("Keep")
	})

	it("typed notes stay: the step is not taken back, and one undo removes the text with the notes slide", async () => {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const slide = s.session.deck.slides[1] as SlideRef
		const history = sessionEdits(s.session).history
		const depth = history.depth
		const started = await s.command({ family: "notes", kind: "setNotes", slide, body: lines() })

		if (!started.ok) throw new Error("setNotes refused")

		const target = (await review(s.context, slide, { comments: false })).notes

		if (target === undefined) throw new Error("no notes body")

		expect((await s.command({ family: "text", kind: "setText", target, body: lines("Hello") })).ok).toBe(true)
		expect(await editCapability.retract(s.context, started.revision)).toEqual({ ok: false, refusal: "stale" })
		expect((await review(s.context, slide, { comments: false })).notesText).toBe("Hello")
		expect(history.depth).toEqual({ undo: depth.undo + 1, redo: 0 })

		// One undo: no notes slide at all (nothing for a save to write), the depth as before.
		expect((await s.undo()).ok).toBe(true)
		expect((await review(s.context, slide, { comments: false })).notes).toBeUndefined()
		expect(history.depth).toEqual({ undo: depth.undo, redo: 1 })
		expect(history.dirty).toBe(false)

		// One redo: the notes slide and its text.
		expect((await s.redo()).ok).toBe(true)
		expect((await review(s.context, slide, { comments: false })).notesText).toBe("Hello")
		expect(history.depth).toEqual({ undo: depth.undo + 1, redo: 0 })
		expect((await s.undo()).ok).toBe(true)
		expect((await review(s.context, slide, { comments: false })).notes).toBeUndefined()
	})

	it("further typing in the same burst stays in that one step", async () => {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const slide = s.session.deck.slides[1] as SlideRef
		const history = sessionEdits(s.session).history
		const depth = history.depth

		expect((await s.command({ family: "notes", kind: "setNotes", slide, body: lines() })).ok).toBe(true)

		const target = (await review(s.context, slide, { comments: false })).notes

		if (target === undefined) throw new Error("no notes body")

		expect((await s.command({ family: "text", kind: "setText", target, body: lines("He"), burst: 1 })).ok).toBe(true)
		expect((await s.command({ family: "text", kind: "setText", target, body: lines("Hello"), burst: 1 })).ok).toBe(true)
		expect(history.depth).toEqual({ undo: depth.undo + 1, redo: 0 })
		expect((await s.undo()).ok).toBe(true)
		expect((await review(s.context, slide, { comments: false })).notes).toBeUndefined()
		expect((await s.redo()).ok).toBe(true)
		expect((await review(s.context, slide, { comments: false })).notesText).toBe("Hello")
	})
})

describe("notes started and not yet written in", () => {
	const lines = (...texts: string[]) => ({
		bodyPr: {},
		paragraphs: texts.map(text => ({ pPr: {}, runs: [{ kind: "r" as const, text, rPr: {} }] }))
	})

	async function deckOf() {
		const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
		const [first, second] = s.session.deck.slides as SlideRef[]

		if (first === undefined || second === undefined) throw new Error("two slides")

		return { s, first, second, history: sessionEdits(s.session).history }
	}

	it("leave a clean deck clean, and a save of it writes nothing", async () => {
		const { s, second, history } = await deckOf()

		expect((await s.command({ family: "notes", kind: "setNotes", slide: second, body: lines() })).ok).toBe(true)
		expect(history.dirty).toBe(false)
		expect((await s.save()).result.kind).toBe("unchanged")
	})

	it("are taken back by a save of other edits first: not written, gone from the session, the history as before them", async () => {
		const { s, first, second, history } = await deckOf()

		expect((await s.command({ family: "notes", kind: "setNotes", slide: first, body: lines("Kept") })).ok).toBe(true)

		const depth = history.depth
		const started = await s.command({ family: "notes", kind: "setNotes", slide: second, body: lines() })

		if (!started.ok) throw new Error("setNotes refused")

		const saved = await s.save()

		expect(saved.result.kind).toBe("written")

		if (saved.bytes === undefined) throw new Error("not saved")

		// The file has the first slide's notes and no notes slide for the second.
		const reopened = await driveSession(saved.bytes, "pptx")
		const [one, two] = reopened.session.deck.slides as SlideRef[]

		expect((await review(reopened.context, one as SlideRef, { comments: false })).notesText).toBe("Kept")
		expect((await review(reopened.context, two as SlideRef, { comments: false })).notes).toBeUndefined()

		// The session took them back as retract would (the history as before them, clean against the file); the page's
		// editor may still be on them, so their body is still answered, and the page's retract drops them for good.
		expect((s.session.deck.nodes.get(second) as SlideNode).notes).toBeUndefined()
		expect((await review(s.context, second, { comments: false })).notes).toBeDefined()
		expect(history.depth).toEqual(depth)
		expect(history.dirty).toBe(false)
		expect((await editCapability.retract(s.context, started.revision)).ok).toBe(true)
		expect((await review(s.context, second, { comments: false })).notes).toBeUndefined()
	})

	it("an undo with them on top takes them back and undoes the step before, in one call", async () => {
		const { s, first, second, history } = await deckOf()
		const firstBefore = (await review(s.context, first, { comments: false })).notesText

		expect((await s.command({ family: "notes", kind: "setNotes", slide: first, body: lines("Earlier") })).ok).toBe(true)

		const depth = history.depth

		expect((await s.command({ family: "notes", kind: "setNotes", slide: second, body: lines() })).ok).toBe(true)
		expect((await s.undo()).ok).toBe(true)
		expect((await review(s.context, second, { comments: false })).notes).toBeUndefined()
		expect((await review(s.context, first, { comments: false })).notesText).toBe(firstBefore)
		expect(history.depth).toEqual({ undo: depth.undo - 1, redo: 1 })

		// The redo is the earlier step, and nothing of the notes started after it.
		expect((await s.redo()).ok).toBe(true)
		expect((await review(s.context, first, { comments: false })).notesText).toBe("Earlier")
		expect((await review(s.context, second, { comments: false })).notes).toBeUndefined()
		expect(history.depth).toEqual(depth)
	})
})
