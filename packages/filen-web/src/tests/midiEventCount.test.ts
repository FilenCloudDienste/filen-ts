import { beforeAll, describe, expect, it } from "vitest"
import { BasicMIDI } from "spessasynth_core"
import { MIDI_MAX_EVENTS, midiEventCount } from "@filen/shared"
import { importPristineSpessasynth, type PristineSpessasynth } from "@/tests/support/pristineSpessasynth"

// The MIDI worker refuses a song by midiEventCount before spessasynth_core parses it, and the parser (patched) stops on
// its own past BasicMIDI.maxEvents: the two must agree on what a file holds, or a song slips past one of them.

// A deterministic generator (mulberry32), so a failing case can be found again by its seed.
function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function be32(value: number): number[] {
	return [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

// Tracks of random bytes leaning towards MIDI: status bytes, data, long and short quantities, meta and SysEx, and now
// and then a chunk length that lies. An `honest` one never lies and holds no end-of-track meta before its end (which
// the parser's flush drops), so upstream's parse holds every event the count finds.
function fuzzedSong(seed: number, honest = false): Uint8Array {
	const next = random(seed)
	const pick = (values: readonly number[]): number => values[Math.floor(next() * values.length)] ?? 0
	const trackCount = 1 + Math.floor(next() * 3)
	const out = [...Buffer.from("MThd"), ...be32(6), 0, 1, 0, trackCount, 0x01, 0xe0]

	for (let track = 0; track < trackCount; track++) {
		// Opened by a delta and a note-on, so running status is set and most of the corpus parses.
		const body: number[] = [0x00, 0x90]
		const length = Math.floor(next() * 200)

		while (body.length < length) {
			const roll = next()

			if (roll < 0.15) {
				body.push(pick([0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0]) | Math.floor(next() * 16))
			} else if (roll < 0.2) {
				const type = Math.floor(next() * 0x80)

				body.push(0xff, honest && type === 0x2f ? 0x01 : type, Math.floor(next() * 6))
			} else if (roll < 0.23) {
				body.push(pick([0xf0, 0xf7]), Math.floor(next() * 8))
			} else if (roll < 0.26) {
				body.push(0x81, 0x81, 0x81, 0x81, 0x81, 0x01)
			} else if (roll < 0.28) {
				body.push(pick([0xf1, 0xf2, 0xf8, 0xfe]))
			} else {
				body.push(Math.floor(next() * 0x80))
			}
		}

		const lies = next() < 0.1 && !honest

		out.push(...Buffer.from("MTrk"), ...be32(lies ? body.length + 1 + Math.floor(next() * 1000) : body.length), ...body)
	}

	return Uint8Array.from(out)
}

// Whether the parser takes the file with at most `maxEvents` events: the count it holds is the least that passes.
function parses(bytes: Uint8Array, maxEvents: number): boolean {
	const previous = BasicMIDI.maxEvents

	BasicMIDI.maxEvents = maxEvents

	try {
		BasicMIDI.fromArrayBuffer(bytes.slice().buffer)

		return true
	} catch {
		return false
	} finally {
		BasicMIDI.maxEvents = previous
	}
}

// The parser's own count of the file's events, found through its cap; null where it refuses the file anyway.
function parsedEvents(bytes: Uint8Array): number | null {
	if (!parses(bytes, Number.POSITIVE_INFINITY)) {
		return null
	}

	const counted = midiEventCount(bytes)

	// The count, checked from both sides: it passes at exactly that cap, and not one below.
	return counted !== null && parses(bytes, counted) && (counted === 0 || !parses(bytes, counted - 1)) ? counted : -1
}

describe("midiEventCount against spessasynth_core's parse", () => {
	it("counts what the parser parses, and refuses what it refuses, across a fuzzed corpus", () => {
		let compared = 0

		for (let seed = 1; seed <= 3000; seed++) {
			const bytes = fuzzedSong(seed)
			const counted = midiEventCount(bytes)
			const parsed = parsedEvents(bytes)

			expect({ seed, counted }).toEqual({ seed, counted: parsed })
			compared += parsed === null ? 0 : 1
		}

		// Most of the corpus parses: the comparison is of counts, not only of refusals.
		expect(compared).toBeGreaterThan(1000)
	})

	it("refuses a track declaring more bytes than the file holds, which the parser would allocate", () => {
		const lying = Uint8Array.from([
			...Buffer.from("MThd"),
			...be32(6),
			0,
			0,
			0,
			1,
			0x01,
			0xe0,
			...Buffer.from("MTrk"),
			...be32(16 << 20),
			0x00,
			0x90,
			0x3c,
			0x40
		])

		expect(midiEventCount(lying)).toBeNull()
		expect(parsedEvents(lying)).toBeNull()
	})

	it("counts a long delta quantity to its end, as the parser reads it", () => {
		// A five-byte delta, then a SysEx the four-byte reading would take for a huge one.
		const body = [0x81, 0x81, 0x81, 0x81, 0x00, 0x90, 0x3c, 0x40, 0x00, 0x3c, 0x00]
		const song = Uint8Array.from([
			...Buffer.from("MThd"),
			...be32(6),
			0,
			0,
			0,
			1,
			0x01,
			0xe0,
			...Buffer.from("MTrk"),
			...be32(body.length),
			...body
		])

		expect(parsedEvents(song)).toBe(2)
		expect(midiEventCount(song)).toBe(2)
	})

	it("is stopped by the parser itself past the cap the worker sets", () => {
		const notes = MIDI_MAX_EVENTS + 10
		const body: number[] = [0x00, 0x90, 0x3c, 0x40]

		for (let i = 1; i < notes; i++) {
			body.push(0x00, 0x3c, 0x40)
		}

		const song = Uint8Array.from([
			...Buffer.from("MThd"),
			...be32(6),
			0,
			0,
			0,
			1,
			0x01,
			0xe0,
			...Buffer.from("MTrk"),
			...be32(body.length),
			...body
		])
		const previous = BasicMIDI.maxEvents

		BasicMIDI.maxEvents = MIDI_MAX_EVENTS

		try {
			expect(midiEventCount(song, MIDI_MAX_EVENTS)).toBeGreaterThan(MIDI_MAX_EVENTS)
			expect(() => BasicMIDI.fromArrayBuffer(song.slice().buffer)).toThrow(RangeError)
		} finally {
			BasicMIDI.maxEvents = previous
		}
	})
})

// The oracle no patch can bend: upstream's parser as published, for files where the patch's three behaviours (a chunk
// longer than the file, an event's data past its track, the event cap) do not arise or change no count.
describe("midiEventCount against spessasynth_core as published", () => {
	let pristine: PristineSpessasynth

	beforeAll(async () => {
		pristine = await importPristineSpessasynth()
	})

	const upstreamEvents = (bytes: Uint8Array): number | null => {
		try {
			return pristine.BasicMIDI.fromArrayBuffer(bytes.slice().buffer).tracks.reduce((sum, track) => sum + track.events.length, 0)
		} catch {
			return null
		}
	}

	it("is the unpatched parser", () => {
		expect("maxEvents" in pristine.BasicMIDI).toBe(false)
	})

	it("counts every event upstream's parse holds, across an honest fuzzed corpus", () => {
		let compared = 0

		for (let seed = 1; seed <= 3000; seed++) {
			const bytes = fuzzedSong(seed, true)
			const upstream = upstreamEvents(bytes)

			if (upstream === null) {
				continue
			}

			expect({ seed, counted: midiEventCount(bytes) }).toEqual({ seed, counted: upstream })
			compared++
		}

		expect(compared).toBeGreaterThan(1000)
	})

	it("refuses a chunk declaring more than the file holds, which upstream allocates and parses", () => {
		const body = [0x00, 0x90, 0x3c, 0x40]
		const lying = Uint8Array.from([
			...Buffer.from("MThd"),
			...be32(6),
			0,
			0,
			0,
			1,
			0x01,
			0xe0,
			...Buffer.from("MTrk"),
			...be32(body.length + 4096),
			...body
		])

		expect(upstreamEvents(lying)).not.toBeNull()
		expect(midiEventCount(lying)).toBeNull()
		expect(() => BasicMIDI.fromArrayBuffer(lying.slice().buffer)).toThrow(RangeError)
	})

	it("clamps an event's data to its track where upstream reads past it, counting the same", () => {
		// A SysEx declaring 100 bytes with 3 left in its track.
		const body = [0x00, 0x90, 0x3c, 0x40, 0x00, 0xf0, 0x64, 0x01, 0x02, 0x03]
		const song = Uint8Array.from([
			...Buffer.from("MThd"),
			...be32(6),
			0,
			0,
			0,
			1,
			0x01,
			0xe0,
			...Buffer.from("MTrk"),
			...be32(body.length),
			...body
		])
		// The SysEx's data, as either parser holds it.
		const sysEx = (midi: unknown): number | undefined =>
			(midi as { tracks: { events: { data: Uint8Array }[] }[] }).tracks[0]?.events[1]?.data.length

		expect(midiEventCount(song)).toBe(upstreamEvents(song))
		expect(sysEx(pristine.BasicMIDI.fromArrayBuffer(song.slice().buffer))).toBe(100)
		expect(sysEx(BasicMIDI.fromArrayBuffer(song.slice().buffer))).toBe(3)
	})

	it("stops past the cap the worker sets, where upstream parses on", () => {
		const body: number[] = [0x00, 0x90, 0x3c, 0x40]

		for (let i = 0; i < 50; i++) {
			body.push(0x00, 0x3c, 0x40)
		}

		const song = Uint8Array.from([
			...Buffer.from("MThd"),
			...be32(6),
			0,
			0,
			0,
			1,
			0x01,
			0xe0,
			...Buffer.from("MTrk"),
			...be32(body.length),
			...body
		])
		const previous = BasicMIDI.maxEvents

		BasicMIDI.maxEvents = 40

		try {
			expect(upstreamEvents(song)).toBe(51)
			expect(midiEventCount(song)).toBe(51)
			expect(() => BasicMIDI.fromArrayBuffer(song.slice().buffer)).toThrow(RangeError)
		} finally {
			BasicMIDI.maxEvents = previous
		}
	})
})
