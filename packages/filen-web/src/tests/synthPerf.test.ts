import { describe, expect, it } from "vitest"
import { BasicMIDI } from "spessasynth_core"

// The perf gate's MIDI parse cost, which sets the event cap the MIDI worker refuses songs past (250 000): parsing a
// song holds about 200 bytes per event, so a capped song parses in well under the worker's 60 MiB.

const EVENTS = 100_000
const WORKER_HEAP_BYTES = 60 * 1024 * 1024
const MIDI_MAX_EVENTS = 250_000

function denseSong(notes: number): ArrayBuffer {
	const events: number[] = [0x00, 0xc0, 0x00]

	for (let i = 0; i < notes; i++) {
		events.push(0x00, 0x90, 60 + (i % 24), 100, 0x01, 0x80, 60 + (i % 24), 0)
	}

	events.push(0x00, 0xff, 0x2f, 0x00)

	const length = events.length
	const bytes = Uint8Array.from([
		0x4d,
		0x54,
		0x68,
		0x64,
		0,
		0,
		0,
		6,
		0,
		0,
		0,
		1,
		0x01,
		0xe0,
		0x4d,
		0x54,
		0x72,
		0x6b,
		length >>> 24,
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
		...events
	])

	return bytes.buffer
}

describe("MIDI parse cost", () => {
	it("keeps a song at the event cap within the worker's heap budget", () => {
		const song = denseSong(EVENTS / 2)
		const before = process.memoryUsage().heapUsed
		const midi = BasicMIDI.fromArrayBuffer(song)
		const perEvent = (process.memoryUsage().heapUsed - before) / EVENTS

		expect(midi.duration).toBeGreaterThan(0)
		expect(perEvent * MIDI_MAX_EVENTS).toBeLessThan(WORKER_HEAP_BYTES)
	})
})
