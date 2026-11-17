/// <reference lib="webworker" />
import { BasicMIDI, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer, type BasicSoundBank } from "spessasynth_core"
import { MIDI_MAX_EVENTS, midiEventCount, synthCap } from "@filen/shared"
import { SYNTH_SOURCE_ERROR, SYNTH_UNSUPPORTED_PREFIX, type SynthRequest, type SynthResponse } from "@/workers/synth/protocol"

// MIDI songs rendered by spessasynth with the bundled SoundFont, started by the remux worker for MIDI playback and
// analysis. The bank is fetched and parsed once per worker and kept across songs; its samples decode lazily under a
// budget per renderer, released when the renderer closes. Each song is parsed once per file key, with the sound bank
// an RMI carries, and each renderer plays it on a synthesizer of its own.

const scope = self as unknown as DedicatedWorkerGlobalScope

// Decoded sample data each renderer's synthesizer keeps, in bytes; what a closed one decoded goes with it, but for the
// samples another open renderer holds.
const DECODED_SAMPLE_BUDGET = 32 * 1024 * 1024
// The id an RMI's own bank is added under, ahead of the bundled one; not spessasynth's own embedded id, which its
// sequencer clears and parses again for every song it loads.
const SONG_BANK = "song"
const VOICE_CAP = 128
// After the last event, the notes' release rings on this long.
const RELEASE_SECONDS = 2
const QUANTUM = 128
const MIDI_CAP = synthCap("midi")

interface Song {
	midi: BasicMIDI
	// An RMI's own sound bank, parsed once for every renderer of the song, and the bank offset it is played at.
	bank: BasicSoundBank | null
	bankOffset: number
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

// The parse itself stops at the cap too, so no file gets past it whatever the count above makes of it.
BasicMIDI.maxEvents = MIDI_MAX_EVENTS

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

// Parses the song once for every renderer of its key, and answers its length (with the release tail) without one.
function load(key: string, data: ArrayBuffer): { duration: number } {
	if (data.byteLength > MIDI_CAP) {
		throw new Unsupported("larger than the MIDI player reads")
	}

	const bytes = new Uint8Array(data)
	// Counted before anything is parsed: a song past the cap is refused at the cost of one walk.
	const events = midiEventCount(bytes, MIDI_MAX_EVENTS)

	if (events === null) {
		throw new Unsupported("not a MIDI file this player reads")
	}

	if (events > MIDI_MAX_EVENTS) {
		throw new Unsupported(`more than ${String(MIDI_MAX_EVENTS)} events`)
	}

	let midi: BasicMIDI

	try {
		midi = BasicMIDI.fromArrayBuffer(data)
	} catch (error) {
		throw new Unsupported(error instanceof Error ? error.message : String(error))
	}

	// A header dividing a beat into 0 ticks makes the song endless.
	if (!Number.isFinite(midi.duration) || midi.duration < 0) {
		throw new Unsupported("the song has no length")
	}

	let bank: BasicSoundBank | null = null

	if (midi.embeddedSoundBank !== undefined) {
		try {
			bank = SoundBankLoader.fromArrayBuffer(midi.embeddedSoundBank)
		} catch (error) {
			throw new Unsupported(error instanceof Error ? error.message : String(error))
		}

		// Taken here: the sequencer would otherwise parse it again for each renderer.
		delete midi.embeddedSoundBank
	}

	songs.set(key, { midi, bank, bankOffset: midi.bankOffset })

	return { duration: midi.duration + RELEASE_SECONDS }
}

async function open(key: string, sampleRate: number): Promise<{ handle: number }> {
	const song = songs.get(key)

	if (song === undefined) {
		throw new SourceLost("the song was unloaded")
	}

	if (bankUrl === null) {
		throw new SourceLost("no sound bank")
	}

	const soundBank = await loadBank(bankUrl)

	const synth = new SpessaSynthProcessor(sampleRate, { decodedSampleBudget: DECODED_SAMPLE_BUDGET, effectsEnabled: true })

	synth.setSystemParameter("voiceCap", VOICE_CAP)
	synth.soundBankManager.addSoundBank(soundBank, "main")

	if (song.bank !== null) {
		synth.soundBankManager.addSoundBank(song.bank, SONG_BANK, song.bankOffset)
		synth.soundBankManager.priorityOrder = [SONG_BANK, ...synth.soundBankManager.priorityOrder.filter(id => id !== SONG_BANK)]
	}

	await synth.ready

	const sequencer = new SpessaSynthSequencer(synth)

	// Sample 0 is song time 0, and the song plays once. Samples decode as notes first need them, not all up front.
	sequencer.skipToFirstNoteOn = false
	sequencer.loopCount = 0
	sequencer.preload = false
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

	return { handle }
}

// Drops a renderer, not destroying it (that destroys the sound bank every renderer shares), with the samples it
// decoded that no other renderer holds.
function close(handle: number): void {
	const renderer = renderers.get(handle)

	if (renderer === undefined) {
		return
	}

	renderers.delete(handle)

	const others = [...renderers.values()]

	renderer.synth.releaseDecodedSamples(sample => others.some(other => other.synth.holdsDecodedSample(sample)))
}

function seek(renderer: Renderer, seconds: number): number {
	const position = Math.max(0, Math.min(seconds, renderer.song + RELEASE_SECONDS))

	// Inside the release tail the song stays at its end: only the release renders, and nothing restarts.
	renderer.sequencer.currentTime = Math.min(position, renderer.song)
	renderer.position = position

	// A renderer a reader played to the end before (and left for this one) has its sequencer stopped there.
	if (renderer.sequencer.paused) {
		renderer.sequencer.play()
	}

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
		// libopenmpt's alone.
		case "init":
		case "probe":
			throw new Unsupported(`${request.type} is the module synthesizer's`)
		case "load":
			return load(request.key, request.data)
		case "unload":
			songs.delete(request.key)

			return {}
		case "open":
			return open(request.key, request.sampleRate)
		case "close":
			close(request.handle)

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

	// Taken up now: the remux worker counts the request's deadline from here, not from the time it queued behind others.
	scope.postMessage({ id, started: true })

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
