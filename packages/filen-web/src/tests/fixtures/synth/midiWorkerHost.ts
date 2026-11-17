import { readFileSync } from "node:fs"
import { getHeapStatistics, setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { parentPort, workerData } from "node:worker_threads"

// The MIDI worker (workers/synth/midi.worker.ts) in a thread of its own, as the browser runs it: its scope's messages
// go to and from the parent, and the SoundFont it fetches is read from disk. A `heap` message answers the thread's
// heap and external memory after collecting garbage, a `cpu` message the CPU time the thread has used, in microseconds.

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

port.on("message", (message: { type: string; id: number }) => {
	if (message.type === "heap") {
		collect()
		collect()

		const stats = getHeapStatistics()

		port.postMessage({ id: message.id, heap: stats.used_heap_size + stats.external_memory })

		return
	}

	if (message.type === "cpu") {
		const { user, system } = process.threadCpuUsage()

		port.postMessage({ id: message.id, cpu: user + system })

		return
	}

	listener?.({ data: message })
})
