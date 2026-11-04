import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { sliceClock } from "../core/slicing"
import { presentationScheduler, realmScheduler, SLICE_MS, type PresentationWorkerScheduler } from "../dom/presentation/scheduler"
import type { CallSignal, Lane } from "../dom/presentation/engine"

// The presentation worker's scheduler: background work in slices of at most 8 ms, taken round robin, and the
// priority lane (layoutText, command, undo, redo, textSeed, the visible render) served before the next background
// slice.

const SIGNAL: CallSignal = { aborted: false, onAbort: () => undefined }

// The scheduler's clock, advanced only by the work below: slices and latencies are then the scheduler's decisions,
// exactly, and not whatever else the machine ran meanwhile (or the resolution of its CPU clock).
let clockMs = 0
const now = (): number => clockMs

function busy(ms: number): void {
	clockMs += ms
}

// The worker's scheduler on that clock. Node drains a MessagePort's queue in one go, so its other ports' messages
// would wait behind the turns (a browser runs each message as a task of its own, in order): here a turn is a
// check-phase macrotask.
function scheduler(): PresentationWorkerScheduler {
	return presentationScheduler({ turn: () => new Promise(resolve => setImmediate(resolve)), now })
}

// A background job of `total` ms of work in 0.5 ms steps, pausing when its slice is due; the length of each slice.
function backgroundJob(
	scheduler: PresentationWorkerScheduler,
	total: number,
	slices: number[],
	order: string[],
	name: string
): Promise<void> {
	return new Promise(resolve => {
		scheduler.schedule(
			"background",
			async slicing => {
				const clock = sliceClock(slicing)
				let spent = 0
				let slice = now()

				while (spent < total) {
					busy(0.5)
					spent += 0.5

					if (clock.due) {
						slices.push(now() - slice)
						order.push(name)
						await clock.pause()
						slice = now()
					}
				}

				slices.push(now() - slice)
				resolve()
			},
			SIGNAL
		)
	})
}

describe("presentation scheduler", () => {
	it("cuts background work into slices of at most 8 ms, taken round robin", { timeout: 20_000 }, async () => {
		const shared = scheduler()
		const slices: number[] = []
		const order: string[] = []

		await Promise.all([
			backgroundJob(shared, 60, slices, order, "save"),
			backgroundJob(shared, 60, slices, order, "index"),
			backgroundJob(shared, 60, slices, order, "thumbs")
		])

		// 60 ms each in slices of 8 (the last 4).
		expect(slices).toHaveLength(3 * 8)
		expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_MS)
		// Each job yields to the others: no job runs two slices back to back while the others wait.
		expect(order.slice(0, 6)).toEqual(["save", "index", "thumbs", "save", "index", "thumbs"])
	})

	it("serves a priority call within 12 ms of its request while three background jobs run", { timeout: 20_000 }, async () => {
		const shared = scheduler()
		const latencies: number[] = []
		const slices: number[] = []
		const order: string[] = []
		const channel = new MessageChannel()
		let requests = 0
		let requestedAt = 0
		let jobsDone = false

		// A request arrives as a message posted while a background slice runs (as the page's postMessage does).
		channel.port1.on("message", async () => {
			const slicing = shared.slicing("priority" satisfies Lane)
			const clock = sliceClock(slicing)

			// 4 ms of layout, pausing when due as layoutText does.
			for (let k = 0; k < 8; k++) {
				busy(0.5)

				if (clock.due) await clock.pause()
			}

			latencies.push(now() - requestedAt)
		})

		const jobs = Promise.all([
			backgroundJob(shared, 200, slices, order, "save"),
			backgroundJob(shared, 200, slices, order, "index"),
			backgroundJob(shared, 200, slices, order, "thumbs")
		]).then(() => {
			jobsDone = true
		})
		// Each request is the poster's background turn, taken round robin with the jobs' slices.
		const poster = new Promise<void>(resolve => {
			const post = (): void => {
				if (requests === 10) {
					resolve()

					return
				}

				shared.schedule(
					"background",
					() => {
						busy(1)
						requestedAt = now()
						channel.port2.postMessage(0)
						requests++
						expect(jobsDone).toBe(false)
						post()

						return Promise.resolve()
					},
					SIGNAL
				)
			}

			post()
		})

		await Promise.all([jobs, poster])
		await new Promise(resolve => setTimeout(resolve, 50))
		channel.port1.close()

		expect(latencies).toHaveLength(10)
		// Its own 4 ms, and at most the background slice under way (SLICE_MS).
		expect(Math.max(...latencies)).toBeLessThanOrEqual(SLICE_MS + 4)
		expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_MS)
	})

	it("runs scheduled work only while its signal is not aborted", async () => {
		const scheduler = realmScheduler()
		let ran = false

		scheduler.schedule(
			"background",
			() => {
				ran = true

				return Promise.resolve()
			},
			{ aborted: true, onAbort: () => undefined }
		)
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(ran).toBe(false)
		expect(scheduler.waiting).toEqual({ priority: 0, background: 0 })
	})
})
