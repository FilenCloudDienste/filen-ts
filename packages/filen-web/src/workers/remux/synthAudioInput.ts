import { AudioSample } from "mediabunny"
import type { AudioSynthKind } from "@filen/shared"
import { BlockCache } from "@/lib/media/blockCache"
import { BLOCK_INPUT_PROFILES, type BlockInputProfile } from "@/lib/media/blockInput"
import { rangePortReader } from "@/lib/media/rangePort"
import { REMUX_WORKER_IDLE_MS, SourceReadError, type RemuxStats } from "@/lib/media/remuxTypes"
import soundFontUrl from "@/assets/soundfonts/GeneralUser-GS-2.0.3.sf3?url"
import MidiWorker from "@/workers/synth/midi.worker.ts?worker"
import ModuleWorker from "@/workers/synth/module.worker.ts?worker"
import { compileLibopenmpt } from "@/workers/synth/libopenmptWasm"
import { NestedWorker } from "@/workers/nestedWorker"
import { AudioUnsupportedError, openAudioInput, type AudioInput } from "@/workers/remux/audioInput"
import type { SampleItem, SampleReader } from "@/workers/remux/audioTranscode"
import { SYNTH_SOURCE_ERROR, SYNTH_UNSUPPORTED_PREFIX, type SynthRequest, type SynthResponse } from "@/workers/synth/protocol"

// Audio a synthesizer renders rather than a decoder decodes: tracker modules (libopenmpt) and MIDI (spessasynth). The file
// is read whole once, into one buffer per file key that the player's input and the crossfade analysis's share while
// either is open; each reader renders the song on its own in the nested synthesizer worker.

export interface SynthHint {
	kind: AudioSynthKind
	// The file's identity: inputs of the same key share its bytes.
	key: string
}

const SAMPLE_RATE = 48_000
const CHANNELS = 2
// Frames per render: about 85 ms, a few dozen messages a second of playback at most.
const RENDER_FRAMES = 4096

// A file key the synthesizer worker holds, and how many inputs use it there.
interface Held {
	worker: Worker
	users: number
	// Settles once the bytes are in the worker, with the song's length when the worker answered it: a second input
	// opens only after.
	loaded: Promise<number | undefined>
}

// What a new instance is told before anything else.
type Setup = () => Promise<SynthRequest>

class Synth {
	public readonly nested: NestedWorker<SynthRequest, SynthResponse>
	private readonly held = new Map<string, Held>()
	// What a new instance is told first (the compiled libopenmpt, the MIDI synthesizer's sound bank), the instance last
	// told, and the telling.
	private readonly setup: Setup
	private setUp: Worker | null = null
	private told: Promise<void> = Promise.resolve()

	public constructor(spawn: () => Worker, name: string, setup: Setup) {
		this.setup = setup
		this.nested = new NestedWorker(spawn, {
			name,
			idleMs: REMUX_WORKER_IDLE_MS,
			toError: message =>
				message.startsWith(SYNTH_UNSUPPORTED_PREFIX)
					? new AudioUnsupportedError(message.slice(SYNTH_UNSUPPORTED_PREFIX.length))
					: message === SYNTH_SOURCE_ERROR
						? new SourceReadError(new Error(`the ${name} lost the file`))
						: new Error(message),
			// A crash or a trap in the synthesizer is the source's failure to the player: Retry starts a fresh one.
			toLostError: message => new SourceReadError(new Error(message))
		})
	}

	// Tells a new instance its setup before anything else is asked of it (answered in order).
	private tell(worker: Worker): Promise<void> {
		if (this.setUp !== worker) {
			this.setUp = worker
			this.told = this.setup().then(
				request => {
					this.nested.request(worker, request).catch(() => undefined)
				},
				(error: unknown) => {
					// The next user tells it again.
					this.setUp = null

					throw error
				}
			)
		}

		return this.told
	}

	// The worker holding `key`'s bytes, loaded through `read` when it does not yet (or no longer: a worker that failed
	// took them with it), and the song's length when the worker answered it. Balanced by one release.
	public async acquire(key: string, read: () => Promise<Uint8Array>): Promise<{ worker: Worker; duration: number | undefined }> {
		const worker = this.nested.acquire()
		let entry = this.held.get(key)

		try {
			await this.tell(worker)

			if (entry?.worker === worker) {
				entry.users++
			} else {
				const load = async (): Promise<number | undefined> => {
					const data = (await read()).slice().buffer
					const response = await this.nested.request(worker, { type: "load", key, data }, [data])

					return response.duration
				}

				entry = { worker, users: 1, loaded: load() }
				this.held.set(key, entry)
			}

			return { worker, duration: await entry.loaded }
		} catch (error) {
			this.release(key, worker)

			throw error
		}
	}

	public release(key: string, worker: Worker): void {
		const held = this.held.get(key)

		if (held?.worker === worker && --held.users <= 0) {
			this.held.delete(key)

			if (this.nested.current(worker)) {
				this.nested.request(worker, { type: "unload", key }).catch(() => undefined)
			}
		}

		this.nested.release(worker)
	}
}

const synths: Partial<Record<AudioSynthKind, Synth>> = {}

function synthFor(kind: AudioSynthKind): Synth {
	if (kind === "module") {
		synths.module ??= new Synth(
			() => new ModuleWorker({ name: "module-synth" }),
			"module synthesizer",
			async () => ({
				type: "init",
				wasm: await compileLibopenmpt()
			})
		)

		return synths.module
	}

	// The bundled SoundFont, same-origin: never fetched from anywhere else.
	synths.midi ??= new Synth(
		() => new MidiWorker({ name: "midi-synth" }),
		"MIDI synthesizer",
		() => Promise.resolve({ type: "bank", url: new URL(soundFontUrl, self.location.href).href })
	)

	return synths.midi
}

// The song from `time` on, rendered in RENDER_FRAMES chunks by a renderer of its own.
function synthReader(synth: Synth, worker: Worker, key: string, isCancelled: () => boolean): SampleReader {
	let handle: number | null = null
	let opening: Promise<number> | null = null
	let closed = false

	const opened = (): Promise<number> => {
		opening ??= synth.nested.request(worker, { type: "open", key, sampleRate: SAMPLE_RATE }).then(response => {
			if (response.handle === undefined) {
				throw new Error("the synthesizer opened no renderer")
			}

			handle = response.handle

			return response.handle
		})

		return opening
	}

	const chunk = async (timestamp: number): Promise<SampleItem | null> => {
		if (closed || isCancelled()) {
			return null
		}

		const id = await opened()
		const response = await synth.nested.request(worker, { type: "render", handle: id, frames: RENDER_FRAMES })
		const frames = response.frames ?? 0

		if (frames === 0 || response.data === undefined) {
			return null
		}

		const sample = new AudioSample({
			data: response.data,
			format: "f32",
			numberOfChannels: CHANNELS,
			sampleRate: SAMPLE_RATE,
			timestamp
		})

		return { sample, timestamp, duration: frames / SAMPLE_RATE, type: "key" }
	}

	return {
		first: async time => {
			const id = await opened()
			// The renderer reports where it landed (a row boundary), which the first item's time is.
			const { position } = await synth.nested.request(worker, { type: "seek", handle: id, seconds: time })

			return chunk(position ?? time)
		},
		next: item => chunk(item.timestamp + item.duration),
		close: () => {
			closed = true

			if (handle !== null && synth.nested.current(worker)) {
				synth.nested.request(worker, { type: "close", handle }).catch(() => undefined)
			}

			return Promise.resolve()
		}
	}
}

// A synthesizer's input over the file `port` serves. Rejects with AudioUnsupportedError when the synthesizer does not
// read the file, and with SourceReadError when its bytes did not arrive.
export async function synthAudioInput(port: MessagePort, size: number, profile: BlockInputProfile, hint: SynthHint): Promise<AudioInput> {
	const reader = rangePortReader(port)
	const cache = new BlockCache(
		size,
		(start, end, signal) =>
			reader.readRange(start, end, signal).catch((error: unknown) => {
				throw signal.aborted ? error : new SourceReadError(error)
			}),
		BLOCK_INPUT_PROFILES[profile]
	)
	const synth = synthFor(hint.kind)
	let worker: Worker | null = null

	const close = (): void => {
		cache.abort()
		reader.close()
	}

	try {
		const acquired = await synth.acquire(hint.key, () => cache.readThrough(0, size))

		worker = acquired.worker
		// The file's bytes are in the synthesizer: the port is not read again.
		close()

		const held = worker
		let duration = acquired.duration ?? 0

		if (acquired.duration === undefined) {
			const probe = await synth.nested.request(held, { type: "open", key: hint.key, sampleRate: SAMPLE_RATE })

			if (probe.handle !== undefined) {
				synth.nested.request(held, { type: "close", handle: probe.handle }).catch(() => undefined)
			}

			duration = probe.duration ?? 0
		}

		if (!(duration > 0)) {
			throw new AudioUnsupportedError("the song has no length")
		}

		let released = false

		return {
			info: { codec: hint.kind, sampleRate: SAMPLE_RATE, channels: CHANNELS, duration, header: null },
			cache,
			reader: (_stats: RemuxStats, isCancelled) => synthReader(synth, held, hint.key, isCancelled),
			close: () => {
				if (!released) {
					released = true
					synth.release(hint.key, held)
				}

				return Promise.resolve()
			}
		}
	} catch (error) {
		close()

		if (worker !== null) {
			synth.release(hint.key, worker)
		}

		throw error
	}
}

// The input playback and analysis read: a synthesizer's for a file the hint names one for, else the decoders'.
export function playbackAudioInput(port: MessagePort, size: number, profile: BlockInputProfile, hint?: SynthHint): Promise<AudioInput> {
	return hint === undefined ? openAudioInput(port, size, profile) : synthAudioInput(port, size, profile, hint)
}
