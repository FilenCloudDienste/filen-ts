import { readFileSync } from "node:fs"
import { getHeapStatistics, setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { parentPort, workerData } from "node:worker_threads"

// The MIDI worker (workers/synth/midi.worker.ts) in a thread of its own, as the browser runs it: its scope's messages
// go to and from the parent, and the SoundFont it fetches is read from disk. A `heap` message answers the thread's
// heap and external memory after collecting garbage, a `cpu` message the CPU time the thread has used, in microseconds, and a `calibrate` message the CPU time a fixed
// reference workload took on it.

interface HostData {
	readonly soundFont: string
}

type Listener = (event: { data: unknown }) => void

const port =
	parentPort ??
	(() => {
		throw new Error("not a worker thread")
	})()
const { soundFont } = workerData as HostData
let listener: Listener | null = null

// A worker thread takes no --expose-gc: the flag is set here, and a fresh context hands over the gc it exposes.
setFlagsFromString("--expose-gc")

const collect = runInNewContext("gc") as () => void

// The global object stands in for the worker's scope, as in a browser (its libraries reach the globals through `self`).
Object.assign(globalThis, {
	self: globalThis,
	addEventListener: (_type: string, handler: Listener) => {
		listener = handler
	},
	postMessage: (message: unknown, transfer: Transferable[] = []) => {
		port.postMessage(message, transfer as never)
	},
	close: () => undefined,
	fetch: () => Promise.resolve(new Response(readFileSync(soundFont)))
})

await import("@/workers/synth/midi.worker")

// A fixed amount of a synthesizer's kind of work: voices reading samples out of a 16 MiB table (as a bank's are) through
// a one-pole filter into a stereo float block, as many blocks as 2 s of 48 kHz audio. Its CPU time is the yardstick a
// render's is measured against: a slower or busier machine, or a neighbour thrashing the cache, slows both alike.
const CALIBRATION_BLOCKS = Math.ceil((2 * 48_000) / 4096)
const calibrationSamples = Float32Array.from({ length: 1 << 22 }, (_, i) => Math.sin(i * 0.001))
const calibrationBlock = new Float32Array(4096 * 2)

function calibrate(): void {
	let state = 0

	for (let block = 0; block < CALIBRATION_BLOCKS; block++) {
		calibrationBlock.fill(0)

		for (let voice = 0; voice < 64; voice++) {
			const step = 1 + voice * 0.37
			let position = ((block * 64 + voice) * 131_071) % (calibrationSamples.length - 4096 * 16)

			for (let i = 0; i < 4096; i++) {
				const index = position | 0
				const sample = calibrationSamples[index] ?? 0
				const next = calibrationSamples[index + 1] ?? 0

				state += 0.05 * (sample + (next - sample) * (position - index) - state)
				calibrationBlock[i * 2] = (calibrationBlock[i * 2] ?? 0) + state * 0.015
				calibrationBlock[i * 2 + 1] = (calibrationBlock[i * 2 + 1] ?? 0) - state * 0.015
				position += step
			}
		}
	}
}

port.on("message", (message: { type: string; id: number }) => {
	if (message.type === "heap") {
		collect()
		collect()

		const stats = getHeapStatistics()

		port.postMessage({ id: message.id, heap: stats.used_heap_size + stats.external_memory })

		return
	}

	if (message.type === "calibrate") {
		const before = process.threadCpuUsage()

		calibrate()

		const after = process.threadCpuUsage(before)

		port.postMessage({ id: message.id, cpu: after.user + after.system })

		return
	}

	if (message.type === "cpu") {
		const { user, system } = process.threadCpuUsage()

		port.postMessage({ id: message.id, cpu: user + system })

		return
	}

	listener?.({ data: message })
})
