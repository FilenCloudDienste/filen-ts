import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { MIDI_MAX_EVENTS } from "@filen/shared"

// The MIDI worker's parse budget, which sets the event cap it refuses songs past: a song at MIDI_MAX_EVENTS parses
// within 40 MiB of the worker's 60, the rest the bank's and the synthesizer's. Measured in a node of its own with collections forced around the parse, so a collection
// in between cannot make the gate pass.

const PARSE_BYTES = 40 * 1024 * 1024

// Runs `body` (an ES module's statements) in `node --expose-gc` and returns what it prints, parsed.
function measure(body: string): unknown {
	const output = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", body], {
		cwd: new URL("../..", import.meta.url),
		encoding: "utf8"
	})

	return JSON.parse(output)
}

describe("MIDI parse cost", () => {
	it("keeps a song at the event cap within the worker's heap budget", () => {
		const { bytes, duration } = measure(`
			import { BasicMIDI } from "spessasynth_core"

			const notes = ${String(MIDI_MAX_EVENTS)} / 2 - 2
			const events = [0x00, 0xc0, 0x00]

			for (let i = 0; i < notes; i++) {
				events.push(0x00, 0x90, 60 + (i % 24), 100, 0x01, 0x80, 60 + (i % 24), 0)
			}

			events.push(0x00, 0xff, 0x2f, 0x00)

			const length = events.length
			const song = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b,
				length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...events]).buffer

			BasicMIDI.maxEvents = ${String(MIDI_MAX_EVENTS)}
			gc()
			gc()

			const before = process.memoryUsage()
			const midi = BasicMIDI.fromArrayBuffer(song)

			gc()
			gc()

			const after = process.memoryUsage()

			process.stdout.write(JSON.stringify({
				bytes: after.heapUsed - before.heapUsed + after.arrayBuffers - before.arrayBuffers,
				duration: midi.duration
			}))
		`) as { bytes: number; duration: number }

		expect(duration).toBeGreaterThan(0)
		expect(bytes).toBeLessThan(PARSE_BYTES)
	})
})
