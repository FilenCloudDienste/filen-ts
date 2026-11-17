import { closeSync, openSync, readSync } from "node:fs"
import { parentPort, workerData, type MessagePort } from "node:worker_threads"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { SyncRangePort } from "@filen/office/dom/pdfedit"
import { serveFileSyncRange } from "@/lib/media/syncRangeServe"

// The SDK worker's end of the sync range bridge in a thread of its own (the reader blocks its thread on the answer):
// the app's serveFileSyncRange over a file on disk, each source read counted in `counts` as a download would be: the
// reads in slot 0, and each block's reads in slot 1 + block.

interface RangeServerData {
	readonly path: string
	readonly length: number
	readonly buffer: SharedArrayBuffer
	readonly port: MessagePort
	readonly counts: SharedArrayBuffer
}

const data = workerData as RangeServerData
const counts = new Int32Array(data.counts)
const fd = openSync(data.path, "r")
const lifetime = new AbortController()
// Node's port, as the structural port the server listens on (a message's data under `data`, as in a browser).
const port: SyncRangePort = {
	postMessage: message => {
		data.port.postMessage(message)
	},
	addEventListener: (_type, listener) => {
		data.port.on("message", (message: unknown) => {
			listener({ data: message })
		})
	},
	close: () => {
		data.port.close()
	}
}

lifetime.signal.addEventListener("abort", () => {
	closeSync(fd)
})

serveFileSyncRange(data.buffer, port, {
	read: (start, end) => {
		const bytes = new Uint8Array(end - start)

		readSync(fd, bytes, 0, bytes.length, start)
		Atomics.add(counts, 0, 1)

		for (let block = Math.floor(start / BLOCK_BYTES); block < Math.ceil(end / BLOCK_BYTES); block++) Atomics.add(counts, 1 + block, 1)

		return Promise.resolve(bytes)
	},
	length: data.length,
	lifetime,
	readerLock: "unused"
})
parentPort?.postMessage("ready")
