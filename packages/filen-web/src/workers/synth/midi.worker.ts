/// <reference lib="webworker" />
import { BasicMIDI, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer, type BasicSoundBank } from "spessasynth_core"
import { midiEventCount } from "@filen/shared"
import { SYNTH_SOURCE_ERROR, SYNTH_UNSUPPORTED_PREFIX, type SynthRequest, type SynthResponse } from "@/workers/synth/protocol"

// MIDI songs rendered by spessasynth with the bundled SoundFont, started by the remux worker for MIDI playback and
// analysis. The bank is fetched and parsed once per worker and kept across songs; its samples decode lazily under a
// budget. Each song is parsed once per file key, and each renderer plays it on a synthesizer of its own.

const scope = self as unknown as DedicatedWorkerGlobalScope

// Events a song may hold: its parse costs about 200 bytes each.
const MIDI_MAX_EVENTS = 250_000
// Decoded sample data each synthesizer keeps, in bytes.
const DECODED_SAMPLE_BUDGET = 32 * 1024 * 1024
const VOICE_CAP = 128
// After the last event, the notes' release rings on this long.
const RELEASE_SECONDS = 2
const QUANTUM = 128

interface Song {
	bytes: Uint8Array
	midi: BasicMIDI | null
}

interface Renderer {
	synth: SpessaSynthProcessor
	sequencer: SpessaSynthSequencer
	sampleRate: number
	// Seconds: the song's own length, and where the next render starts.
	song: number
	position: number
	left: Float32Array
	right: Float32Array
}

const songs = new Map<string, Song>()
const renderers = new Map<number, Renderer>()
let nextHandle = 1
let bank: Promise<BasicSoundBank> | null = null
let bankUrl: string | null = null

class Unsupported extends Error {}
class SourceLost extends Error {}

function loadBank(url: string): Promise<BasicSoundBank> {
	bankUrl = url
	bank ??= fetch(url).then(
		async response => {
			if (!response.ok) {
				throw new SourceLost(`the SoundFont answered ${String(response.status)}`)
			}

			return SoundBankLoader.fromArrayBuffer(await response.arrayBuffer())
		},
		(error: unknown) => {
			throw new SourceLost(error instanceof Error ? error.message : String(error))
		}
	)
	// A failed fetch is tried again by the next open.
	bank.catch(() => {
		bank = null
	})

	return bank
}

function load(key: string, data: ArrayBuffer): void {
	const bytes = new Uint8Array(data)
	// Counted before anything is parsed: a song past the cap is refused at the cost of one walk.
	const events = midiEventCount(bytes, MIDI_MAX_EVENTS)

	if (events === null) {
		throw new Unsupported("not a MIDI file")
	}

	if (events > MIDI_MAX_EVENTS) {
		throw new Unsupported(`more than ${String(MIDI_MAX_EVENTS)} events`)
	}

	songs.set(key, { bytes, midi: null })
}

async function open(key: string, sampleRate: number): Promise<{ handle: number; duration: number }> {
	const song = songs.get(key)

	if (song === undefined) {
		throw new SourceLost("the song was unloaded")
	}

	if (bankUrl === null) {
		throw new SourceLost("no sound bank")
	}

	const soundBank = await loadBank(bankUrl)

	if (song.midi === null) {
		try {
			song.midi = BasicMIDI.fromArrayBuffer(song.bytes.slice().buffer)
		} catch (error) {
			throw new Unsupported(error instanceof Error ? error.message : String(error))
		}
	}

	const synth = new SpessaSynthProcessor(sampleRate, { decodedSampleBudget: DECODED_SAMPLE_BUDGET, effectsEnabled: true })

	synth.setSystemParameter("voiceCap", VOICE_CAP)
	synth.soundBankManager.addSoundBank(soundBank, "main")
	await synth.ready

	const sequencer = new SpessaSynthSequencer(synth)

	// Sample 0 is song time 0, and the song plays once.
	sequencer.skipToFirstNoteOn = false
	sequencer.loopCount = 0
	sequencer.loadNewSongList([song.midi])
	sequencer.play()

	const handle = nextHandle++
	const length = sequencer.duration

	renderers.set(handle, {
		synth,
		sequencer,
		sampleRate,
		song: length,
		position: 0,
		left: new Float32Array(QUANTUM),
		right: new Float32Array(QUANTUM)
	})

	return { handle, duration: length + RELEASE_SECONDS }
}

function seek(renderer: Renderer, seconds: number): number {
	const position = Math.max(0, Math.min(seconds, renderer.song + RELEASE_SECONDS))

	// Inside the release tail the song stays at its end: only the release renders, and nothing restarts.
	renderer.sequencer.currentTime = Math.min(position, renderer.song)
	renderer.position = position

	return position
}

function render(renderer: Renderer, frames: number): { data: ArrayBuffer; frames: number } {
	const left = Math.max(0, Math.round((renderer.song + RELEASE_SECONDS - renderer.position) * renderer.sampleRate))
	const count = Math.min(frames, left)
	const out = new Float32Array(count * 2)

	for (let done = 0; done < count; done += QUANTUM) {
		const quantum = Math.min(QUANTUM, count - done)

		renderer.left.fill(0)
		renderer.right.fill(0)

		if (renderer.position + done / renderer.sampleRate < renderer.song) {
			renderer.sequencer.processTick()
		}

		renderer.synth.process(renderer.left, renderer.right, 0, quantum)

		for (let i = 0; i < quantum; i++) {
			out[(done + i) * 2] = renderer.left[i] ?? 0
			out[(done + i) * 2 + 1] = renderer.right[i] ?? 0
		}
	}

	renderer.position += count / renderer.sampleRate

	return { data: out.buffer, frames: count }
}

async function answer(request: SynthRequest): Promise<Omit<SynthResponse, "id">> {
	switch (request.type) {
		case "bank":
			bankUrl = request.url

			return {}
		case "load":
			load(request.key, request.data)

			return {}
		case "unload":
			songs.delete(request.key)

			return {}
		case "open":
			return open(request.key, request.sampleRate)
		case "close":
			// Dropped, not destroyed: destroying a synthesizer destroys the sound bank every renderer shares.
			renderers.delete(request.handle)

			return {}
		default: {
			const renderer = renderers.get(request.handle)

			if (renderer === undefined) {
				return { error: SYNTH_SOURCE_ERROR }
			}

			return request.type === "seek" ? { position: seek(renderer, request.seconds) } : render(renderer, request.frames)
		}
	}
}

scope.addEventListener("message", (event: MessageEvent<SynthRequest & { id: number }>) => {
	const { id } = event.data

	answer(event.data).then(
		response => {
			scope.postMessage({ id, ...response }, response.data === undefined ? [] : [response.data])
		},
		(error: unknown) => {
			if (error instanceof Unsupported) {
				scope.postMessage({ id, error: `${SYNTH_UNSUPPORTED_PREFIX}${error.message}` })
			} else if (error instanceof SourceLost) {
				scope.postMessage({ id, error: SYNTH_SOURCE_ERROR })
			} else {
				scope.postMessage({ id, fatal: error instanceof Error ? error.message : String(error) })
				scope.close()
			}
		}
	)
})
