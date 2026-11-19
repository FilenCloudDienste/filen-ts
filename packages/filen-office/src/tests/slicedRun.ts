import { PerformanceObserver } from "node:perf_hooks"
import type { Slicing } from "../core/slicing"

// A sliced run on an in-thread host, measured: the longest the thread was held between two turns, in this thread's
// CPU time (what the host's other work waits for; the wall clock of a loaded machine would count other processes'
// time too). The slices follow the same clock. Node only (perf_hooks, process.threadCpuUsage).

// A stretch between two turns: its wall-clock window and the thread's CPU time spent in it.
export interface Stretch {
	readonly fromWall: number
	readonly toWall: number
	readonly cpu: number
}

// A garbage collection pause, on the wall clock.
export interface Collection {
	readonly start: number
	readonly end: number
}

export interface SlicedRun<T> {
	readonly result: T
	// The longest stretch (ms of CPU time, collections left out).
	readonly longest: number
	readonly turns: number
	readonly wall: number
	readonly cpu: number
}

function threadMs(): number {
	const usage = process.threadCpuUsage()

	return (usage.user + usage.system) / 1000
}

// The longest stretch less the collections within its window (clamped at zero): garbage collection pauses are the
// runtime's, not the slices'. CPU time less wall-clock pauses, so approximate.
export function longestStretch(stretches: readonly Stretch[], collections: readonly Collection[]): number {
	let longest = 0

	for (const stretch of stretches) {
		let collecting = 0

		for (const pause of collections) {
			collecting += Math.max(0, Math.min(stretch.toWall, pause.end) - Math.max(stretch.fromWall, pause.start))
		}

		longest = Math.max(longest, stretch.cpu - collecting)
	}

	return longest
}

export async function slicedRun<T>(save: (slicing: Slicing) => Promise<T>): Promise<SlicedRun<T>> {
	const collections: Collection[] = []
	const observer = new PerformanceObserver(list => {
		for (const entry of list.getEntries()) collections.push({ start: entry.startTime, end: entry.startTime + entry.duration })
	})

	observer.observe({ entryTypes: ["gc"] })

	const stretches: Stretch[] = []
	let resumed = threadMs()
	let resumedAt = performance.now()
	const close = (): void => {
		stretches.push({ fromWall: resumedAt, toWall: performance.now(), cpu: threadMs() - resumed })
	}
	const slicing: Slicing = {
		sliceMs: 8,
		now: threadMs,
		pause: async () => {
			close()
			await new Promise(resolve => setTimeout(resolve, 0))
			resumed = threadMs()
			resumedAt = performance.now()
		}
	}

	try {
		const cpu = threadMs()
		const started = performance.now()

		resumed = cpu
		resumedAt = started

		const result = await save(slicing)
		const wall = performance.now() - started
		const used = threadMs() - cpu

		close()

		// GC entries are delivered from a later turn: wait for those of the last stretches before measuring.
		await new Promise(resolve => setTimeout(resolve, 10))

		return { result, longest: longestStretch(stretches, collections), turns: stretches.length - 1, wall, cpu: used }
	} finally {
		observer.disconnect()
	}
}
