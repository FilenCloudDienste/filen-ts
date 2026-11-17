import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { MIDI_MAX_EVENTS } from "@filen/shared"

// The MIDI worker's parse budget, which sets the event cap it refuses songs past: a song at MIDI_MAX_EVENTS parses
// within 40 MiB of the worker's 60, the rest the bank's and the synthesizer's. Measured in a node of its own with collections forced around the parse, so a collection
// in between cannot make the gate pass.

const PARSE_BYTES = 40 * 1024 * 1024
const WORKER_HEAP_BYTES = 60 * 1024 * 1024

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

// A dense song: eight channels, each striking a note every 20 ms over `seconds`, each note held until the next.
// What the host answers: the MIDI worker's own answers, and its heap and CPU readings.
interface HostAnswer {
	id: number
	started?: true
	error?: string
	fatal?: string
	handle?: number
	frames?: number
	heap?: number
	cpu?: number
}

function denseMidi(seconds: number): Uint8Array<ArrayBuffer> {
	const events: number[] = []

	for (let channel = 0; channel < 8; channel++) {
		events.push(0x00, 0xc0 | channel, channel * 8)
	}

	// 480 ticks a quarter at 120 BPM: 20 ms is 19.2 ticks, so 19 or 20 in turn.
	for (let step = 0; step < seconds * 50; step++) {
		for (let channel = 0; channel < 8; channel++) {
			const note = 36 + ((step * 7 + channel * 5) % 48)
			const previous = 36 + (((step - 1) * 7 + channel * 5) % 48)

			if (step > 0) {
				events.push(channel === 0 ? (step % 5 === 0 ? 20 : 19) : 0, 0x80 | channel, previous, 0)
			}

			events.push(step === 0 && channel === 0 ? 0 : 0, 0x90 | channel, note, 96)
		}
	}

	events.push(0x00, 0xff, 0x2f, 0x00)

	const length = events.length

	return Uint8Array.from([
		...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b],
		length >>> 24,
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
		...events
	])
}

describe("MIDI worker", () => {
	it("renders a dense song at under a tenth of a core, adding under 60 MiB to a worker that holds its bank", async () => {
		const { Worker } = await import("node:worker_threads")
		const worker = new Worker(new URL("./fixtures/synth/midiWorkerHost.ts", import.meta.url), {
			execArgv: ["--import", "tsx"],
			workerData: { soundFont: fileURLToPath(new URL("../assets/soundfonts/GeneralUser-GS-2.0.3.sf3", import.meta.url)) }
		})
		let nextId = 0
		const ask = (request: Record<string, unknown>, transfer: ArrayBuffer[] = []) =>
			new Promise<HostAnswer>((resolve, reject) => {
				const id = nextId++
				const answer = (response: HostAnswer): void => {
					// The worker's note that it took the request up is no answer.
					if (response.id !== id || response.started === true) {
						return
					}

					worker.off("message", answer)

					if (response.error !== undefined || response.fatal !== undefined) {
						reject(new Error(response.error ?? response.fatal))
					} else {
						resolve(response)
					}
				}

				worker.on("message", answer)
				worker.postMessage({ id, ...request }, transfer)
			})

		try {
			await ask({ type: "bank", url: "https://app.example/bank.sf3" })

			// A short song played and closed first: the bank is held and the code that parses, plays and renders is
			// compiled, as in a worker that played anything before. What the dense song adds is measured over that.
			const warm = denseMidi(1).buffer

			await ask({ type: "load", key: "warm", data: warm }, [warm])

			const { handle: warmHandle } = await ask({ type: "open", key: "warm", sampleRate: 48_000 })

			await ask({ type: "render", handle: warmHandle, frames: 4096 })
			await ask({ type: "close", handle: warmHandle })
			await ask({ type: "unload", key: "warm" })

			const idle = Number((await ask({ type: "heap" })).heap)
			const song = denseMidi(30).buffer

			await ask({ type: "load", key: "dense", data: song }, [song])

			const { handle } = await ask({ type: "open", key: "dense", sampleRate: 48_000 })
			const SECONDS = 10
			const started = Number((await ask({ type: "cpu" })).cpu)
			let frames = 0

			while (frames < SECONDS * 48_000) {
				frames += Number((await ask({ type: "render", handle, frames: 4096 })).frames)
			}

			// The thread's own CPU time: what else the machine runs meanwhile does not count.
			const elapsed = (Number((await ask({ type: "cpu" })).cpu) - started) / 1_000_000
			const { heap } = await ask({ type: "heap" })

			expect(elapsed / SECONDS).toBeLessThan(0.1)
			expect(Number(heap) - idle).toBeLessThan(WORKER_HEAP_BYTES)
		} finally {
			await worker.terminate()
		}
	}, 120_000)
})
