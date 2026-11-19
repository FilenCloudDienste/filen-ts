import type { NestedResponse } from "@/workers/nestedWorker"

// What the remux worker asks a synthesizer worker (module.worker, midi.worker). A file's bytes are loaded once under
// its key and shared by every renderer opened on them; each renderer plays the song on its own.
export type SynthRequest =
	// What a new instance is told first: the compiled libopenmpt (the module synthesizer's), the sound bank to play
	// with, fetched once per instance (the MIDI synthesizer's).
	| { type: "init"; wasm: WebAssembly.Module }
	| { type: "bank"; url: string }
	// Whether a file of `size` bytes whose head this is reads as a module.
	| { type: "probe"; head: ArrayBuffer; size: number }
	| { type: "load"; key: string; data: ArrayBuffer }
	| { type: "unload"; key: string }
	| { type: "open"; key: string; sampleRate: number }
	| { type: "seek"; handle: number; seconds: number }
	| { type: "render"; handle: number; frames: number }
	| { type: "close"; handle: number }

export interface SynthResponse extends NestedResponse {
	found?: boolean
	handle?: number
	// Seconds: a song's length once loaded, the position a seek landed on.
	duration?: number
	position?: number
	// Interleaved stereo float samples, `frames` of them; fewer than asked at the song's end.
	data?: ArrayBuffer
	frames?: number
	// Bytes the instance's wasm heap has grown to, answered to every load, open, close and unload.
	heap?: number
}

// Error answers: the bytes of the key are gone (the worker restarted; read them again), or the file is not one the
// synthesizer reads, with why.
export const SYNTH_SOURCE_ERROR = "source"
export const SYNTH_UNSUPPORTED_PREFIX = "unsupported:"

// Thrown by a synthesizer's answer: the file is not one it reads (the message says why), or the bytes of its key are
// gone. Anything else thrown is fatal.
export class SynthUnsupported extends Error {}
export class SynthSourceLost extends Error {}

// The part of a synthesizer worker's scope its message loop uses.
export interface SynthScope {
	addEventListener(type: "message", listener: (event: MessageEvent<SynthRequest & { id: number }>) => void): void
	postMessage(message: unknown, transfer?: Transferable[]): void
	close(): void
}

// A synthesizer worker's message loop: each request is acknowledged as taken up, then answered (its samples
// transferred), or its error is answered as unsupported, source lost or fatal. After a fatal one (a trap or an abort)
// nothing in the instance can be trusted any more: the worker closes.
export function serveSynth(scope: SynthScope, answer: (request: SynthRequest) => Promise<Omit<SynthResponse, "id">>): void {
	scope.addEventListener("message", event => {
		const { id } = event.data

		// Taken up now: the remux worker counts the request's deadline from here, not from the time it queued behind others.
		scope.postMessage({ id, started: true })

		answer(event.data).then(
			response => {
				const transfer = response.data === undefined ? [] : [response.data]

				scope.postMessage({ id, ...response }, transfer)
			},
			(error: unknown) => {
				if (error instanceof SynthUnsupported) {
					scope.postMessage({ id, error: `${SYNTH_UNSUPPORTED_PREFIX}${error.message}` })
				} else if (error instanceof SynthSourceLost) {
					scope.postMessage({ id, error: SYNTH_SOURCE_ERROR })
				} else {
					scope.postMessage({ id, fatal: error instanceof Error ? error.message : String(error) })
					scope.close()
				}
			}
		)
	})
}
