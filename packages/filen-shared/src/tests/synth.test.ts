import { describe, expect, it } from "vitest"
import { AUDIO_FORMATS, audioSynthKind, isMidiHead, MIDI_MAX_PORTS, midiEventCount, synthCap } from "@filen/shared"

function vlq(value: number): number[] {
	const out = [value & 0x7f]

	for (let rest = value >> 7; rest > 0; rest >>= 7) {
		out.unshift((rest & 0x7f) | 0x80)
	}

	return out
}

function chunk(id: string, body: number[]): number[] {
	return [...id]
		.map(char => char.charCodeAt(0))
		.concat([body.length >>> 24, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], body)
}

// A Standard MIDI File of one track: a program change, `notes` note-ons in running status with their note-offs, a
// tempo meta event and a SysEx, then the end of track.
function smf(notes: number): Uint8Array {
	const events = [0x00, 0xc0, 0x05, 0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xf0, 0x02, 0x7e, 0xf7]

	for (let i = 0; i < notes; i++) {
		events.push(...vlq(i === 0 ? 0 : 240), ...(i === 0 ? [0x90] : []), 60, 100, ...vlq(240), 62, 0)
	}

	events.push(0x00, 0xff, 0x2f, 0x00)

	return Uint8Array.from([...chunk("MThd", [0, 0, 0, 1, 0x01, 0xe0]), ...chunk("MTrk", events)])
}

function le(value: number): number[] {
	return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24]
}

describe("midiEventCount", () => {
	it("counts every event, running status and meta and SysEx ones included", () => {
		expect(midiEventCount(smf(10))).toBe(4 + 20)
	})

	it("counts an RMI's song, so the wrapper cannot hide one past the cap", () => {
		const song = [...smf(10)]
		const data = [..."data"].map(char => char.charCodeAt(0)).concat(le(song.length), song)
		const rmi = Uint8Array.from(
			[..."RIFF"]
				.map(char => char.charCodeAt(0))
				.concat(
					le(4 + data.length),
					[..."RMID"].map(char => char.charCodeAt(0)),
					data
				)
		)

		expect(midiEventCount(rmi)).toBe(24)
	})

	it("stops counting past its limit, and gives nothing for what is not MIDI", () => {
		expect(midiEventCount(smf(5000), 100)).toBeGreaterThan(100)
		expect(midiEventCount(smf(5000), 100)).toBeLessThan(400)
		expect(midiEventCount(new Uint8Array(64))).toBeNull()
		expect(midiEventCount(Uint8Array.from([...chunk("MThd", [0, 0, 0, 1, 0, 96]), ...chunk("MTrk", [0x00, 0x40, 0x00])]))).toBeNull()
	})

	it("names no synthesizer for decoded formats", () => {
		expect(audioSynthKind("mp3")).toBeUndefined()
	})

	it("caps each synthesizer at its rows' own cap", () => {
		expect(synthCap("midi")).toBe(4 * 1024 * 1024)
		expect(synthCap("module")).toBe(32 * 1024 * 1024)
		expect(Number(AUDIO_FORMATS.get("mid")?.cap)).toBe(synthCap("midi"))
		expect(Number(AUDIO_FORMATS.get("xm")?.cap)).toBe(synthCap("module"))
	})

	it("tells a MIDI head, bare or in an RMI, from anything else", () => {
		const rmi = Uint8Array.from([..."RIFF\0\0\0\0RMIDdata"].map(char => char.charCodeAt(0)))

		expect(isMidiHead(smf(1))).toBe(true)
		expect(isMidiHead(rmi)).toBe(true)
		expect(isMidiHead(Uint8Array.from([..."RIFF\0\0\0\0WAVE"].map(char => char.charCodeAt(0))))).toBe(false)
		expect(isMidiHead(Uint8Array.of(0x00, 0x00, 0x01, 0xba))).toBe(false)
		expect(isMidiHead(new Uint8Array(0))).toBe(false)
	})

	it("refuses a song addressing more ports than the synthesizer allots channels for", () => {
		const track = (port: number): number[] => chunk("MTrk", [0x00, 0xff, 0x21, 0x01, port, 0x00, 0x90, 60, 100, 0x00, 0xff, 0x2f, 0x00])
		const song = (ports: number): Uint8Array =>
			Uint8Array.from([
				...chunk("MThd", [0, 1, 0, ports, 0x01, 0xe0]),
				...Array.from({ length: ports }, (_, port) => track(port)).flat()
			])

		expect(midiEventCount(song(MIDI_MAX_PORTS))).toBe(MIDI_MAX_PORTS * 3)
		expect(midiEventCount(song(MIDI_MAX_PORTS + 1))).toBeNull()
	})
})
