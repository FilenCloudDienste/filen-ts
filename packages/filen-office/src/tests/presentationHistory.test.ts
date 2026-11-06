import { describe, expect, it } from "vitest"
import type { Touch } from "../core/presentation/edit/apply"
import { digestOf, sameDigest } from "../core/presentation/edit/changes"
import { DeckHistory, touchKey, type Fingerprint, type HistoryLimits } from "../core/presentation/edit/history"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef } from "../core/presentation/model"
import { budget, cpuMs } from "./timing"

// The deck history over a toy model (a map of key → value): each step sets keys, its inverse sets them back.

const SLIDE = slideRef(1)

function touch(id: number): Touch {
	return { kind: "shape", slide: SLIDE, shape: id, dirt: { kind: "xfrm" } }
}

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

	// Sets shape `id`'s value (undefined removes it) as one step, coalescing into `burst`; the inverse is kept as the
	// prior value.
	set(id: number, value: string | undefined, options: { burst?: string; bytes?: number } = {}): void {
		const key = touchKey(touch(id))
		const before = new Map([[key, this.fingerprint(key)]])
		const prior = this.values.get(key)

		if (value === undefined) this.values.delete(key)
		else this.values.set(key, value)
		this.history.push({
			op: {
				family: "shape",
				kind: "setAlt",
				target: { slide: SLIDE, id },
				alt: value === undefined ? undefined : { descr: value }
			} as DeckOp,
			inverse: {
				ops: [
					{
						family: "shape",
						kind: "setAlt",
						target: { slide: SLIDE, id },
						alt: prior === undefined ? undefined : { descr: prior }
					}
				],
				bytes: options.bytes ?? 0
			},
			touches: [touch(id)],
			before,
			after: new Map([[key, this.fingerprint(key)]]),
			bytes: options.bytes ?? 10,
			burst: options.burst
		})
	}

	private replay(op: DeckOp | undefined): void {
		if (op?.family !== "shape" || op.kind !== "setAlt") return

		const key = touchKey(touch(op.target.id))

		if (op.alt?.descr === undefined) this.values.delete(key)
		else this.values.set(key, op.alt.descr)
	}

	undo(): void {
		const step = this.history.peekUndo()

		for (const op of step?.inverse.ops ?? []) this.replay(op)

		this.history.undone()
	}

	redo(): void {
		this.replay(this.history.peekRedo()?.op)
		this.history.redone()
	}
}

describe("deck history", () => {
	it("undo back to the saved state is clean; redo is dirty again", () => {
		const toy = new Toy()

		toy.set(1, "a")
		toy.set(2, "b")
		expect(toy.history.dirty).toBe(true)
		toy.undo()
		toy.undo()
		expect(toy.history.dirty).toBe(false)
		expect(toy.history.atSaved).toBe(true)
		toy.redo()
		expect(toy.history.dirty).toBe(true)
	})

	it("an op followed by the op of its inverse cancels out though both are new steps", () => {
		const toy = new Toy()

		toy.set(1, "a")
		toy.set(2, "b")
		toy.set(1, undefined)
		expect([...toy.history.dirtyTouchKeys()]).toEqual(["s:1:2:x"])
		toy.set(2, undefined)
		expect(toy.history.dirty).toBe(false)
		expect(toy.history.atSaved).toBe(false)
	})

	it("a discarded redo branch that held the saved state never looks saved at the same position", () => {
		const toy = new Toy()

		toy.set(1, "a")

		const point = toy.history.savePoint()

		toy.history.commit(point)
		expect(toy.history.dirty).toBe(false)
		toy.undo()
		expect(toy.history.dirty).toBe(true)
		// A new step at the position the saved state had, with another value.
		toy.set(1, "z")
		expect(toy.history.atSaved).toBe(false)
		expect(toy.history.dirty).toBe(true)
		// Writing the saved value again is clean by fingerprint, though no step is the saved one.
		toy.set(1, "a")
		expect(toy.history.dirty).toBe(false)
		expect(toy.history.atSaved).toBe(false)
	})

	it("a save point committed after more steps makes exactly its state the saved one", () => {
		const toy = new Toy()

		toy.set(1, "a")

		const point = toy.history.savePoint()

		toy.set(1, "b")
		toy.history.commit(point)
		expect(toy.history.dirty).toBe(true)
		toy.undo()
		expect(toy.history.dirty).toBe(false)
	})

	it("a typing burst coalesces into one step, undone at once", () => {
		const toy = new Toy()

		toy.set(1, "h", { burst: "b1" })
		toy.set(1, "he", { burst: "b1" })
		toy.set(1, "hey", { burst: "b1" })
		expect(toy.history.size.steps).toBe(1)
		toy.undo()
		expect(toy.values.size).toBe(0)
		expect(toy.history.dirty).toBe(false)
	})

	it("a burst does not coalesce into the saved state's step", () => {
		const toy = new Toy()

		toy.set(1, "h", { burst: "b1" })
		toy.history.commit(toy.history.savePoint())
		toy.set(1, "he", { burst: "b1" })
		expect(toy.history.size.steps).toBe(2)
		toy.undo()
		expect(toy.history.dirty).toBe(false)
	})

	it("is held to its step and byte limits, and a trimmed saved state still reads dirty", () => {
		const toy = new Toy({ maxSteps: 5, maxBytes: 1000 })

		for (let index = 0; index < 20; index++) toy.set(index % 3, `v${String(index)}`)

		expect(toy.history.size.steps).toBe(5)
		expect(toy.history.dirty).toBe(true)

		for (let index = 0; index < 5; index++) toy.undo()

		expect(toy.history.canUndo).toBe(false)
		// The saved state (nothing set) is gone from the timeline: its fingerprints are kept, so this is dirty.
		expect(toy.history.dirty).toBe(true)

		const big = new Toy({ maxSteps: 500, maxBytes: 100 })

		for (let index = 0; index < 50; index++) big.set(index, "x", { bytes: 30 })

		expect(big.history.size.bytes).toBeLessThanOrEqual(100)
	})

	it("trims a step at the limit in time independent of what the saved state's baseline already holds", () => {
		const toy = new Toy({ maxSteps: 50, maxBytes: 64 * 1024 * 1024 })

		// Each trimmed step puts a new key in the saved state's baseline: 20,000 of them.
		for (let id = 0; id < 20_050; id++) toy.set(id, "v")

		const start = cpuMs()

		for (let id = 20_050; id < 21_050; id++) toy.set(id, "v")

		// A copy of the baseline per push (to take that push back) costs seconds here.
		expect(cpuMs() - start).toBeLessThan(budget(50))
		expect(toy.history.size.steps).toBe(50)
		expect(toy.history.dirty).toBe(true)
	})
})

describe("sameDigest", () => {
	it("answers as digestOf(a) === digestOf(b) over model-like values", () => {
		const values: unknown[] = [
			undefined,
			null,
			0,
			Number.NaN,
			1,
			"",
			"1",
			true,
			[],
			[undefined],
			[1, 2],
			[2, 1],
			{},
			{ a: undefined },
			{ src: { part: "x" } },
			{ revision: 3, lock: "gate" },
			{ a: 1 },
			{ a: 1, b: undefined },
			{ b: 2, a: 1 },
			{ a: 1, b: 2 },
			{ a: [1, { c: "x" }] },
			{ a: [1, { c: "y" }] },
			new Map([[1, "x"]]),
			[[1, "x"]],
			new Set([1, 2]),
			new Uint8Array([1, 2, 3]),
			new Uint8Array([1, 2, 4]),
			new Int8Array([1, 2, 3]),
			{ bytes: new Uint8Array([1, 2]), src: 1 },
			{ bytes: new Uint8Array([1, 2]) }
		]

		for (const a of values) for (const b of values) expect([a, b, sameDigest(a, b)]).toEqual([a, b, digestOf(a) === digestOf(b)])
	})
})
