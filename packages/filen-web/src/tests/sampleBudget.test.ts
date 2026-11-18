import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { BasicSample, BasicSoundBank, SoundBankLoader, SpessaLog } from "spessasynth_core"
import { SampleBudget, type BudgetedSynth } from "@/workers/synth/sampleBudget"

// The MIDI worker's decoded-sample budget as a cap: 128 notes struck at once on 128 distinct large compressed samples
// (as a crafted RMI's own bank could hold) keep no more decoded than the budget, however long each sample is.

afterEach(() => {
	BasicSample.maxDecodedBytes = Number.POSITIVE_INFINITY
	BasicSample.admitDecode = () => true
	SpessaLog.setLogLevel(false, true, false)
})

describe("the decoded-sample budget", () => {
	it("holds 128 sounding notes on 128 large samples within the budget, the rest silent", async () => {
		SpessaLog.setLogLevel(false, false, false)
		// The Vorbis decoder compiles asynchronously; a decode before it is ready yields silence.
		await BasicSoundBank.ready

		const bank = SoundBankLoader.fromArrayBuffer(
			readFileSync(new URL("../assets/soundfonts/GeneralUser-GS-2.0.3.sf3", import.meta.url)).buffer
		)
		// The bundled bank's longest compressed sample, copied into 128 samples of their own.
		const longest = bank.samples
			.filter(sample => sample.isCompressed)
			.reduce((best, sample) => (sample.getRawData(true).length > best.getRawData(true).length ? sample : best))
		const vorbis = longest.getRawData(true)
		const decodedBytes = longest.getAudioData().byteLength
		const samples = Array.from({ length: 128 }, (_, index) => {
			const sample = new BasicSample(`copy ${String(index)}`, longest.sampleRate, 60, 0, 1, 0, 1000)

			sample.setStoredData({ form: "vorbis", data: vorbis.slice() })

			return sample
		})
		// Every note sounds at once: each sample's data stays alive in its voice, so nothing can be evicted.
		const sounding = new Set<Float32Array>()
		const voices: BudgetedSynth = {
			decodedSampleData: () => sounding,
			set decodedSampleBudget(_bytes: number) {
				// Nothing to let go of while every note sounds.
			}
		}
		const BUDGET = decodedBytes * 4.5
		const budget = new SampleBudget(BUDGET, () => [voices])

		BasicSample.maxDecodedBytes = 8 * 1024 * 1024
		BasicSample.admitDecode = bytes => budget.admit(bytes)

		let silent = 0

		for (const sample of samples) {
			const data = sample.getAudioData()

			sounding.add(data)
			silent += data.length === 64 ? 1 : 0
		}

		expect(budget.held()).toBeLessThanOrEqual(BUDGET)
		// The bound is an upper estimate of each decode, so fewer than four of them fit in four and a half.
		expect(128 - silent).toBeGreaterThanOrEqual(1)
		expect(128 - silent).toBeLessThanOrEqual(4)
		expect(decodedBytes).toBeGreaterThan(64 * 4)
	})

	it("makes room by letting the caches go of their oldest samples before it refuses one", () => {
		const held = new Set<Float32Array>([new Float32Array(1000)])
		const synth: BudgetedSynth = {
			decodedSampleData: () => held,
			set decodedSampleBudget(_bytes: number) {
				held.clear()
			}
		}
		const budget = new SampleBudget(6000, () => [synth])

		// Full while the note sounds; its cache lets it go to make room.
		expect(budget.admit(4000)).toBe(true)
		expect(held.size).toBe(0)
	})
})
