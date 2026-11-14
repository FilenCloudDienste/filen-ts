import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"
import { savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { PdfEngineClient, type PdfEngineWorkerLike } from "../../dom/pdfedit/client"
import type { PdfOpenResult } from "../../dom/pdfedit/protocol"
import { createSyncRangeBuffer, serveSyncRange, type SyncRangePort, type SyncRangeServerStats } from "../../dom/pdfedit/syncRange"

// The engine tests' harness: an engine worker thread (engineWorker.ts) with the real MuPDF, reading a file through the
// sync range bridge served from the test's thread.

export interface EngineSetup {
	readonly blockBytes?: number
	readonly slots?: number
	// Blocks whose first read rejects, or never settles; later reads of them succeed.
	readonly failBlocks?: Set<number>
	readonly hangBlocks?: Set<number>
	readonly readAhead?: number
	readonly trapOnHeap?: boolean
	readonly deadlineMs?: number
}

export interface Engine {
	readonly client: PdfEngineClient
	readonly stats: SyncRangeServerStats
	readonly buffer: SharedArrayBuffer
	readonly reads: { start: number; end: number }[]
	open(password?: string): Promise<PdfOpenResult>
}

const running: PdfEngineClient[] = []

// Node's MessagePort as the bridge's port (its message events carry `data` like the DOM's).
export function syncPort(port: MessagePort): SyncRangePort {
	return {
		postMessage: message => {
			port.postMessage(message)
		},
		addEventListener: (_type, listener) => {
			port.on("message", data => {
				listener({ data })
			})
		},
		close: () => {
			port.close()
		}
	}
}

export function startEngine(bytes: Uint8Array, setup: EngineSetup = {}): Engine {
	const blockBytes = setup.blockBytes ?? 64 * 1024
	const buffer = createSyncRangeBuffer(setup.slots ?? 16, blockBytes)
	const channel = new MessageChannel()
	const lifetime = new AbortController()
	const reads: { start: number; end: number }[] = []
	const stats = serveSyncRange(
		buffer,
		syncPort(channel.port2),
		{
			length: bytes.length,
			read: (start, end) => {
				reads.push({ start, end })

				for (let block = Math.floor(start / blockBytes); block * blockBytes < end; block++) {
					if (setup.hangBlocks?.delete(block) === true) return new Promise<Uint8Array>(() => undefined)
					if (setup.failBlocks?.delete(block) === true) return Promise.reject(new Error("read failed"))
				}

				return Promise.resolve(bytes.slice(start, end))
			}
		},
		{ lifetime: lifetime.signal, readAhead: setup.readAhead ?? 3, onReaderClose: () => lifetime.abort() }
	)
	const client = spawnEngine(setup, () => {
		lifetime.abort()
	})

	return {
		client,
		stats,
		buffer,
		reads,
		open: password =>
			client.call(
				"open",
				{
					// Transferred to the engine thread, where it is Node's port again.
					channel: { buffer, port: channel.port1 as unknown as SyncRangePort, length: bytes.length },
					role: "edit",
					...(password === undefined ? {} : { password })
				},
				[channel.port1]
			)
	}
}

// An engine worker thread with the real MuPDF; `onTerminate` runs when it is terminated.
export function spawnEngine(setup: EngineSetup, onTerminate?: () => void): PdfEngineClient {
	const worker = new Worker(new URL("./engineWorker.ts", import.meta.url), {
		execArgv: ["--import", "tsx"],
		workerData: { trapOnHeap: setup.trapOnHeap ?? false, deadlineMs: setup.deadlineMs ?? 60_000 }
	})
	const like: PdfEngineWorkerLike = {
		postMessage: (message, transfer) => {
			worker.postMessage(message, transfer as never[])
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			if (type === "message") worker.on("message", data => listener({ data }))
			else worker.on("error", error => listener({ data: error }))
		},
		terminate: () => {
			onTerminate?.()
			void worker.terminate()
		}
	}
	const client = new PdfEngineClient(like)

	running.push(client)

	return client
}

// Terminates every engine the tests started (afterEach).
export function stopEngines(): void {
	for (const client of running.splice(0)) client.terminate()
}

// The held output streamed over a save port, read here as an upload would; `fail` aborts it halfway.
export async function upload(client: PdfEngineClient, fail = false): Promise<{ readonly uploaded: boolean; readonly bytes: Uint8Array }> {
	const channel = new MessageChannel()
	const reader = savePortReader(channel.port2 as unknown as SavePortEnd)
	const written = client.call("writeOutput", { port: channel.port1 }, [channel.port1])
	const chunks: Uint8Array[] = []

	for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
		chunks.push(chunk)

		if (fail) {
			reader.abort("upload")

			break
		}
	}

	if (!fail) reader.settled(true)

	const { uploaded } = await written
	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return { uploaded, bytes }
}
