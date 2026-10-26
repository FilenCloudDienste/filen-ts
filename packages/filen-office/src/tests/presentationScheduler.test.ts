import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { sliceClock } from "../core/slicing"
import {
	presentationScheduler,
	realmClock,
	realmScheduler,
	SLICE_MS,
	type PresentationWorkerScheduler
} from "../dom/presentation/scheduler"
import type { CallSignal, Lane } from "../dom/presentation/engine"
import { cpuMs } from "./timing"

// The presentation worker's scheduler: background work in slices of at most 8 ms, taken round robin, and the
// priority lane (layoutText, command, undo, redo, textSeed, the visible render) served before the next background
// slice.

const SIGNAL: CallSignal = { aborted: false, onAbort: () => undefined }

function busy(ms: number): void {
	const end = cpuMs() + ms

	while (cpuMs() < end) {
		// CPU work the length of `ms`.
	}
}

// A background job of `total` ms of CPU in 0.5 ms steps, pausing when its slice is due; the CPU of each slice.
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
				let slice = cpuMs()

				while (spent < total) {
					busy(0.5)
					spent += 0.5

					if (clock.due) {
						slices.push(cpuMs() - slice)
						order.push(name)
						await clock.pause()
						slice = cpuMs()
					}
				}

				slices.push(cpuMs() - slice)
				resolve()
			},
			SIGNAL
		)
	})
}

describe("presentation scheduler", () => {
	it("cuts background work into slices of at most 8 ms of CPU, taken round robin", { timeout: 20_000 }, async () => {
		const scheduler = realmScheduler()
		const slices: number[] = []
		const order: string[] = []

		await Promise.all([
			backgroundJob(scheduler, 60, slices, order, "save"),
			backgroundJob(scheduler, 60, slices, order, "index"),
			backgroundJob(scheduler, 60, slices, order, "thumbs")
		])

		expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_MS + 1)
		// Each job yields to the others: no job runs two slices back to back while the others wait.
		expect(order.slice(0, 6)).toEqual(["save", "index", "thumbs", "save", "index", "thumbs"])
	})

	it("serves a priority call within 12 ms of CPU of its request while three background jobs run", { timeout: 20_000 }, async () => {
		// Node drains a MessagePort's queue in one go, so its other ports' messages would wait behind the turns (a
		// browser runs each message as a task of its own, in order): here a turn is a check-phase macrotask.
		const scheduler = presentationScheduler({ turn: () => new Promise(resolve => setImmediate(resolve)), now: realmClock() })
		const latencies: number[] = []
		const slices: number[] = []
		const order: string[] = []
		const channel = new MessageChannel()
		let requests = 0
		let requestedAt = 0

		// A request arrives as a message posted while a background slice runs (as the page's postMessage does).
		channel.port1.on("message", async () => {
			const slicing = scheduler.slicing("priority" satisfies Lane)
			const clock = sliceClock(slicing)

			// 4 ms of layout, pausing when due as layoutText does.
			for (let k = 0; k < 8; k++) {
				busy(0.5)

				if (clock.due) await clock.pause()
			}

			latencies.push(cpuMs() - requestedAt)
		})

		const jobs = Promise.all([
			backgroundJob(scheduler, 200, slices, order, "save"),
			backgroundJob(scheduler, 200, slices, order, "index"),
			backgroundJob(scheduler, 200, slices, order, "thumbs")
		])
		const poster = new Promise<void>(resolve => {
			const post = (): void => {
				if (requests === 10) {
					resolve()

					return
				}

				scheduler.schedule(
					"background",
					() => {
						busy(1)
						requestedAt = cpuMs()
						channel.port2.postMessage(0)
						requests++
						setTimeout(post, 20)

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
		expect(Math.max(...latencies)).toBeLessThanOrEqual(12)
		expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_MS + 1)
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
