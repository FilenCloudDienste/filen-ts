import type { NestedResponse } from "@/workers/nestedWorker"

// What the remux worker asks a synthesizer worker (module.worker, midi.worker). A file's bytes are loaded once under
// its key and shared by every renderer opened on them; each renderer plays the song on its own.
export type SynthRequest =
	| { type: "load"; key: string; data: ArrayBuffer }
	| { type: "unload"; key: string }
	| { type: "open"; key: string; sampleRate: number }
	| { type: "seek"; handle: number; seconds: number }
	| { type: "render"; handle: number; frames: number }
	| { type: "close"; handle: number }

export interface SynthResponse extends NestedResponse {
	handle?: number
	// Seconds: a song's length when opened, the position a seek landed on.
	duration?: number
	position?: number
	// Interleaved stereo float samples, `frames` of them; fewer than asked at the song's end.
	data?: ArrayBuffer
	frames?: number
}

// Error answers: the bytes of the key are gone (the worker restarted; read them again), or the file is not one the
// synthesizer reads, with why.
export const SYNTH_SOURCE_ERROR = "source"
export const SYNTH_UNSUPPORTED_PREFIX = "unsupported:"
