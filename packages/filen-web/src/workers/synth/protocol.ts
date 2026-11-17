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
