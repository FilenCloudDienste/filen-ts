import { describe, expect, it } from "vitest"
import type { Touch } from "../core/presentation/edit/apply"
import { DeckHistory, opBytesOf, touchKey, type Fingerprint } from "../core/presentation/edit/history"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef } from "../core/presentation/model"
import { cpuMs } from "./timing"
import { editDeck, editHarness } from "./presentationEditFixtures"

// The history's estimate of the bytes dirty against the saved state (the autosave tiers' 1 KiB rule): the ops and
// inverses of the steps that still leave a key changed, so an edit undone or written back counts nothing.

const SLIDE = slideRef(1)

function touch(id: number): Touch {
	return { kind: "shape", slide: SLIDE, shape: id, dirt: { kind: "xfrm" } }
}

function altOp(id: number, value: string | undefined): DeckOp {
	return {
		family: "shape",
		kind: "setAlt",
		target: { slide: SLIDE, id },
		alt: value === undefined ? undefined : { descr: value }
	} as DeckOp
}

class Toy {
	readonly values = new Map<string, string>()
	readonly history = new DeckHistory(key => this.fingerprint(key))

	fingerprint(key: string): Fingerprint {
		const value = this.values.get(key)

		return value === undefined ? { digest: "", exists: false } : { digest: value, exists: true }
	}

	set(id: number, value: string | undefined): void {
		const key = touchKey(touch(id))
		const before = new Map([[key, this.fingerprint(key)]])
		const inverse = altOp(id, this.values.get(key))

		if (value === undefined) this.values.delete(key)
		else this.values.set(key, value)
		this.history.push({
			op: altOp(id, value),
			inverse: { ops: [inverse], bytes: opBytesOf(inverse) },
			touches: [touch(id)],
			before,
			after: new Map([[key, this.fingerprint(key)]]),
			bytes: 10,
			burst: undefined
		})
	}

	undo(): void {
		const step = this.history.peekUndo()

		for (const op of step?.inverse.ops ?? []) this.replay(op)

		this.history.undone()
	}

	private replay(op: DeckOp): void {
		if (op.family !== "shape" || op.kind !== "setAlt") return

		const key = touchKey(touch(op.target.id))

		if (op.alt?.descr === undefined) this.values.delete(key)
		else this.values.set(key, op.alt.descr)
	}

	save(): void {
		this.history.commit(this.history.savePoint())
	}
}

describe("deck history dirty bytes", () => {
	it("is zero on a clean deck and grows with the size of the change", () => {
		const toy = new Toy()

		expect(toy.history.dirtyBytes).toBe(0)
		toy.set(1, "a")
		expect(toy.history.dirtyBytes).toBeGreaterThan(0)
		expect(toy.history.dirtyBytes).toBeLessThan(1024)
		toy.set(2, "x".repeat(1024))
		expect(toy.history.dirtyBytes).toBeGreaterThanOrEqual(2048)
	})

	it("counts nothing for an edit written back or undone", () => {
		const toy = new Toy()

		toy.set(1, "x".repeat(2048))
		toy.set(1, undefined)
		expect(toy.history.dirty).toBe(false)
		expect(toy.history.dirtyBytes).toBe(0)
		toy.set(2, "y".repeat(2048))
		toy.undo()
		expect(toy.history.dirtyBytes).toBe(0)
	})

	it("counts only what changed since the save", () => {
		const toy = new Toy()

		toy.set(1, "x".repeat(4096))
		toy.save()
		expect(toy.history.dirtyBytes).toBe(0)
		toy.set(2, "b")
		expect(toy.history.dirtyBytes).toBeLessThan(1024)
	})

	it("counts the saved steps undone past the save", () => {
		const toy = new Toy()

		toy.set(1, "x".repeat(2048))
		toy.save()
		toy.undo()
		expect(toy.history.dirty).toBe(true)
		expect(toy.history.dirtyBytes).toBeGreaterThanOrEqual(2048)
	})

	it("reads in constant time however many steps are dirty", () => {
		const toy = new Toy()

		for (let id = 1; id <= 500; id++) toy.set(id, "v")

		const start = cpuMs()
		let total = 0

		for (let read = 0; read < 20_000; read++) total += toy.history.dirtyBytes

		// A walk of the 500 steps per read takes hundreds of ms here.
		expect(cpuMs() - start).toBeLessThan(20)
		expect(total).toBe(20_000 * toy.history.dirtyBytes)
	})

	it("returns to zero after random edits, undos and saves are undone back to the save", () => {
		let seed = 7
		const random = (n: number): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648

			return seed % n
		}

		for (let run = 0; run < 50; run++) {
			const toy = new Toy()
			let applied = 0

			for (let step = 0; step < 40; step++) {
				const roll = random(10)

				if (roll < 6) {
					toy.set(1 + random(5), random(3) === 0 ? undefined : "x".repeat(random(600)))
					applied++
				} else if (roll < 8 && applied > 0) {
					toy.undo()
					applied--
				} else if (roll === 8) {
					toy.save()
					applied = 0
				}

				expect(toy.history.dirtyBytes === 0).toBe(!toy.history.dirty)
			}

			while (applied > 0) {
				toy.undo()
				applied--
			}

			expect(toy.history.dirty).toBe(false)
			expect(toy.history.dirtyBytes).toBe(0)
		}
	})

	it("keeps counting a saved state whose steps left the timeline", () => {
		const toy = new Toy()

		toy.set(1, "x".repeat(2048))
		toy.save()
		toy.undo()
		// A new step drops the redo branch that held the saved state.
		toy.set(2, "b")
		expect(toy.history.dirty).toBe(true)
		expect(toy.history.dirtyBytes).toBeGreaterThanOrEqual(2048)
		// Written back to the saved value: clean again, nothing counted.
		toy.set(1, "x".repeat(2048))
		toy.set(2, undefined)
		expect(toy.history.dirty).toBe(false)
		expect(toy.history.dirtyBytes).toBe(0)
	})
})

describe("the changed event's dirty bytes", () => {
	it("carries the history's estimate after a command and an undo", async () => {
		const harness = await editHarness(editDeck())
		const slide = await harness.slide(0)
		const last = () => harness.events.filter(event => event.type === "changed").at(-1) as { dirtyBytes?: number } | undefined
		const target = { slide: slide.ref, id: 4 }

		await harness.command({ family: "shape", kind: "setAlt", target, alt: { descr: "x" } })
		expect(last()?.dirtyBytes).toBeGreaterThan(0)
		expect(last()?.dirtyBytes).toBeLessThan(1024)
		await harness.command({ family: "shape", kind: "setAlt", target, alt: { descr: "y".repeat(1024) } })
		expect(last()?.dirtyBytes).toBeGreaterThanOrEqual(2048)
		await harness.undo()
		await harness.undo()
		expect(last()?.dirtyBytes).toBe(0)
		harness.close()
	})
})
