import * as Comlink from "comlink"
import {
	WarmGoneError,
	type PcmStreamInfo,
	type RemuxAdoptParams,
	type RemuxAudioStart,
	type RemuxAudioStartParams,
	type RemuxEvent,
	type RemuxMediaInfo,
	type RemuxOpenParams,
	type RemuxSeekParams,
	type RemuxSeekResult,
	type RemuxStats,
	type TrackKind
} from "@/lib/media/remuxTypes"
import { RemuxEngine } from "@/workers/remux/engine"
import { openAudioInput } from "@/workers/remux/audioInput"
import { PcmStream } from "@/workers/remux/pcmStream"
import { WAV_CONTENT_TYPE } from "@/workers/remux/wav.logic"
import { probeEncodeCapabilities } from "@/workers/remux/encodeCaps"
import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import { exposeRangePort } from "@/lib/media/rangePort"

// Remuxes files the browser cannot play as they are (Matroska, or audio it cannot decode) into
// fragmented MP4 for the page's MediaSource. Its own worker so the demuxer's heap is freed with it once
// playback ends, and so a parse never runs on the page or in the SDK worker, whose heap never shrinks.
// More than one session at a time: the next episode is opened while the current one plays.
// The page's callback, a Comlink proxy here: releasing it frees the page's end too.
type EventSink = ((event: RemuxEvent) => unknown) & Partial<Comlink.ProxyMethods>

const sessions = new Map<number, { engine: RemuxEngine; onEvent: EventSink }>()
let nextSession = 0

// A file opened ahead of playback (the next episode, once Up Next shows): its head and index are in its block
// cache when the player's own open adopts it. One at a time; one nobody took closes itself.
interface Warmed {
	key: string
	engine: RemuxEngine
	info: Promise<RemuxMediaInfo>
	adopt: (sink: EventSink) => void
	expiry: ReturnType<typeof setTimeout>
}

const WARM_EXPIRY_MS = 5 * 60_000
// Subtitle cues found while warming wait for the session that adopts the file.
const MAX_WARM_EVENTS = 256
let warmed: Warmed | null = null
// The key of the last open that named a warmed file the worker did not have: its session opened the file
// itself, so a warm arriving for it later would read the file a second time for nobody.
let abandonedWarm: string | null = null

function dropWarmed(key?: string): Promise<void> {
	const entry = warmed

	if (entry === null || (key !== undefined && entry.key !== key)) {
		return Promise.resolve()
	}

	warmed = null
	clearTimeout(entry.expiry)

	return entry.engine.close().catch(() => undefined)
}

function session(id: number): RemuxEngine {
	const entry = sessions.get(id)

	if (entry === undefined) {
		throw new Error("remux session closed")
	}

	return entry.engine
}

async function closeSession(id: number): Promise<void> {
	const entry = sessions.get(id)

	sessions.delete(id)

	if (entry !== undefined) {
		await entry.engine.close()
		// Frees the page's end of the event callback too.
		entry.onEvent[Comlink.releaseProxy]?.()
	}
}

// The WAV streams being served, by the id openPcm handed out.
const pcmStreams = new Map<number, AbortController>()
let nextPcm = 0

function pcmStats(): RemuxStats {
	return {
		blockReads: 0,
		bytesRead: 0,
		rangeReads: 0,
		readAheadBlocks: 0,
		segmentsOut: 0,
		bytesOut: 0,
		transcodeSeconds: 0,
		decodeWaitSeconds: 0,
		transcodedMediaSeconds: 0
	}
}

const api = {
	// Decodes the audio file `params.port` serves into a WAV stream served by range on `output` (the service
	// worker reads it there), until the reader closes `output`. Rejects with AudioUnsupportedError when nothing
	// in the file can be decoded.
	async openPcm(params: { port: MessagePort; size: number }, output: MessagePort): Promise<PcmStreamInfo> {
		let stream: PcmStream

		try {
			const input = await openAudioInput(params.port, params.size)

			try {
				stream = await PcmStream.open(input, pcmStats())
			} catch (error) {
				await input.close()

				throw error
			}
		} catch (error) {
			output.close()

			throw error
		}

		const lifetime = new AbortController()
		const { info } = stream
		const id = nextPcm++

		pcmStreams.set(id, lifetime)
		lifetime.signal.addEventListener(
			"abort",
			() => {
				pcmStreams.delete(id)
				void stream.close()
			},
			{ once: true }
		)
		exposeRangePort(output, (start, end, signal) => stream.read(start, end, signal), lifetime)

		return {
			id,
			size: stream.layout.size,
			contentType: WAV_CONTENT_TYPE,
			codec: info.codec,
			duration: info.duration,
			sampleRate: info.sampleRate,
			channels: info.channels
		}
	},
	// Ends a stream openPcm opened, whether or not its reader ever closed the port (a registration the service
	// worker refused leaves nobody reading it).
	closePcm(id: number): void {
		pcmStreams.get(id)?.abort()
	},
	// Opens `params` under `key` ahead of playback: the head and the index are read into its cache, and where
	// video starts only at IDR pictures, the first one is found. The port belongs to the warmed file from now on.
	async warm(params: RemuxOpenParams, key: string): Promise<void> {
		await dropWarmed()

		if (abandonedWarm === key) {
			abandonedWarm = null
			params.port.close()

			return
		}

		let sink: EventSink | null = null
		const held: RemuxEvent[] = []
		const engine = new RemuxEngine(params, event => {
			if (sink !== null) {
				void sink(event.type === "segment" ? Comlink.transfer(event, [event.bytes.buffer]) : event)
			} else if (event.type === "textCues" && held.length < MAX_WARM_EVENTS) {
				held.push(event)
			}
		})
		const entry: Warmed = {
			key,
			engine,
			info: engine.open(params),
			adopt: next => {
				sink = next

				for (const event of held.splice(0)) {
					void next(event)
				}
			},
			expiry: setTimeout(() => {
				void dropWarmed(key)
			}, WARM_EXPIRY_MS)
		}

		warmed = entry

		try {
			await entry.info
			await engine.canStartAt(0)
		} catch {
			await dropWarmed(key)
		}
	},
	unwarm(key: string): Promise<void> {
		return dropWarmed(key)
	},
	// `onEvent` is the page's Comlink proxy; segments cross transferred. With `warmKey` naming the file warmed
	// last, that file is taken over and a port passed along closes unused; without a port, an open whose warmed
	// file is gone fails with WarmGoneError.
	async open(
		params: (RemuxOpenParams & { warmKey?: string }) | RemuxAdoptParams,
		onEvent: EventSink
	): Promise<{ id: number; info: RemuxMediaInfo }> {
		const ready = warmed

		if (params.warmKey !== undefined && ready?.key === params.warmKey) {
			warmed = null
			clearTimeout(ready.expiry)

			if ("port" in params) {
				params.port.close()
			}

			const id = nextSession++

			ready.adopt(onEvent)
			sessions.set(id, { engine: ready.engine, onEvent })

			try {
				return { id, info: await ready.info }
			} catch (error) {
				await closeSession(id)

				throw error
			}
		}

		if (params.warmKey !== undefined) {
			abandonedWarm = params.warmKey
		}

		if (!("port" in params)) {
			onEvent[Comlink.releaseProxy]?.()

			throw new WarmGoneError()
		}

		const id = nextSession++
		const engine = new RemuxEngine(params, event => {
			void onEvent(event.type === "segment" ? Comlink.transfer(event, [event.bytes.buffer]) : event)
		})

		sessions.set(id, { engine, onEvent })

		try {
			return { id, info: await engine.open(params) }
		} catch (error) {
			await closeSession(id)

			throw error
		}
	},
	seek(id: number, params: RemuxSeekParams): Promise<RemuxSeekResult> {
		return session(id).seek(params)
	},
	switchAudio(id: number, params: RemuxAudioStartParams): Promise<RemuxAudioStart> {
		return session(id).switchAudio(params)
	},
	canStartAt(id: number, time: number): Promise<boolean> {
		return session(id).canStartAt(time)
	},
	stopAudio(id: number): Promise<void> {
		return session(id).stopAudio()
	},
	setHorizon(id: number, kind: TrackKind, generation: number, horizon: number): void {
		sessions.get(id)?.engine.setHorizon(kind, generation, horizon)
	},
	stats(id: number): RemuxStats | null {
		return sessions.get(id)?.engine.snapshotStats() ?? null
	},
	close(id: number): Promise<void> {
		return closeSession(id)
	},
	// The encoders an editor's export can use (capabilities.ts caches the answer per browser build).
	encodeCapabilities(): Promise<EncodeCapabilities> {
		return probeEncodeCapabilities()
	},
	// Held for the worker's whole life, so the page learns the moment it is gone (crashed, terminated):
	// the page waits for the same lock, which it gets only then.
	async holdLifeLock(name: string): Promise<void> {
		const acquired = Promise.withResolvers<undefined>()

		void navigator.locks.request(name, () => {
			acquired.resolve(undefined)

			// Never settles: the lock goes with the worker.
			return new Promise<never>(() => undefined)
		})
		await acquired.promise
	}
}

export type RemuxWorkerApi = typeof api

Comlink.expose(api)
