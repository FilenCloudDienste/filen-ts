import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BasicSample, SoundBankLoader, SpessaLog, SpessaSynthProcessor } from "spessasynth_core"

// The spessasynth_core patch's bound on compressed samples: an Ogg Vorbis stream whose pages allow a decode past
// BasicSample.maxDecodedBytes is never handed to the decoder, and one that cannot be read plays as silence no longer
// than that limit allows, whatever loop end its header claims.

// An Ogg page of `packets` (each a lacing value under 255: a packet of that many bytes).
function oggPage(packets: number[]): number[] {
	const header = [0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, packets.length]

	return [...header, ...packets, ...packets.flatMap(size => new Array<number>(size).fill(0))]
}

// A Vorbis stream's three header packets, its identification one mono with 8192-sample long blocks, then `audio`
// one-byte packets: each may decode to 4096 samples, 16 KiB of floats.
function vorbisStream(audio: number): Uint8Array {
	const identification = [1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 1, 0x44, 0xac, 0, 0]

	identification.push(...new Array<number>(12).fill(0), (13 << 4) | 8, 1)

	const pages = [...oggPage([identification.length]).slice(0, -identification.length), ...identification]
	const rest: number[] = [...oggPage([2, 2])]

	for (let left = audio; left > 0; left -= 200) {
		rest.push(...oggPage(new Array<number>(Math.min(200, left)).fill(1)))
	}

	return Uint8Array.from([...pages, ...rest])
}

function sample(data: Uint8Array, loopEnd: number): BasicSample {
	const compressed = new BasicSample("bomb", 44_100, 60, 0, 1, 0, loopEnd)

	compressed.setStoredData({ form: "vorbis", data })

	return compressed
}

// What spessasynth warns of, which says whether a decode was tried (and failed) or refused before it.
function warnings(): string[] {
	const seen: string[] = []

	vi.spyOn(SpessaLog.logFunctions, "warn").mockImplementation((...message: unknown[]) => {
		seen.push(message.map(String).join(" "))
	})

	return seen
}

afterEach(() => {
	BasicSample.maxDecodedBytes = Number.POSITIVE_INFINITY
	vi.restoreAllMocks()
})

describe("the spessasynth_core patch's compressed-sample bound", () => {
	it("never decodes a stream whose packets could decode past the limit", () => {
		const seen = warnings()

		BasicSample.maxDecodedBytes = 32 * 1024 * 1024

		// 4 000 packets of up to 16 KiB each: past 32 MiB.
		const decoded = sample(vorbisStream(4000), 1000).getAudioData()

		expect(seen).toEqual([expect.stringContaining("not decoded, as it may decode to more than")])
		expect(decoded.length).toBe(1000)
		expect(decoded.every(value => value === 0)).toBe(true)
	})

	it("plays what cannot be read as silence no longer than the limit, whatever loop end the header claims", () => {
		BasicSample.maxDecodedBytes = 32 * 1024 * 1024

		const garbage = sample(new Uint8Array(64).fill(0x5a), 0xffff_fff0).getAudioData()

		expect(garbage.length).toBe(8 * 1024 * 1024)
	})

	it("hands a stream within the limit to the decoder", () => {
		const seen = warnings()

		BasicSample.maxDecodedBytes = 32 * 1024 * 1024
		// A small stream that is no real Vorbis: the decoder is asked, and refuses it.
		sample(vorbisStream(10), 100).getAudioData()

		expect(seen).toEqual([expect.stringContaining("Error decoding sample")])
	})
})

describe("the spessasynth_core patch's decoded-sample budget setter", () => {
	it("releases what a synthesizer decoded past a budget lowered while it plays", async () => {
		const bank = SoundBankLoader.fromArrayBuffer(
			readFileSync(new URL("../assets/soundfonts/GeneralUser-GS-2.0.3.sf3", import.meta.url)).buffer
		)
		const synth = new SpessaSynthProcessor(48_000, { decodedSampleBudget: 32 * 1024 * 1024, effectsEnabled: false })

		synth.soundBankManager.addSoundBank(bank, "main")
		await synth.ready

		const left = new Float32Array(128)
		const right = new Float32Array(128)

		for (const note of [48, 55, 60, 64, 67, 72]) {
			synth.noteOn(0, note, 100)
		}

		synth.process(left, right, 0, 128)
		expect(synth.decodedSampleBytes).toBeGreaterThan(0)

		synth.decodedSampleBudget = 0
		expect(synth.decodedSampleBytes).toBe(0)
	})
})
