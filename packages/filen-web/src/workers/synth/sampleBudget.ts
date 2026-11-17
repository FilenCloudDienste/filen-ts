// The MIDI worker's decoded-sample budget: a cap no decode passes, not a target applied after one. What is held decoded
// is counted where it lives, in each synthesizer's cache, voice cache and sounding voices, each array once however many
// share it, and a sample that may decode to more than the room left is not decoded (it plays as silence).

export interface BudgetedSynth {
	decodedSampleData(): Set<Float32Array>
	set decodedSampleBudget(bytes: number)
}

export class SampleBudget {
	private readonly bytes: number
	private readonly synths: () => Iterable<BudgetedSynth>

	public constructor(bytes: number, synths: () => Iterable<BudgetedSynth>) {
		this.bytes = bytes
		this.synths = synths
	}

	// Splits the budget between the synthesizers' caches: together they keep no more than it decoded.
	public share(): void {
		const synths = [...this.synths()]

		this.setShares(synths, Math.floor(this.bytes / Math.max(1, synths.length)))
	}

	// The decoded sample data alive, in bytes.
	public held(): number {
		const held = new Set<Float32Array>()

		for (const synth of this.synths()) {
			for (const data of synth.decodedSampleData()) {
				held.add(data)
			}
		}

		let bytes = 0

		for (const data of held) {
			bytes += data.byteLength
		}

		return bytes
	}

	// Whether a sample that may decode to `bytes` fits beside what is held: if not at once, once the caches have let go
	// of their oldest samples to make room. What a sounding note plays stays, and counts.
	public admit(bytes: number): boolean {
		if (this.held() + bytes <= this.bytes) {
			return true
		}

		const synths = [...this.synths()]

		this.setShares(synths, Math.floor(Math.max(0, this.bytes - bytes) / Math.max(1, synths.length)))

		const fits = this.held() + bytes <= this.bytes

		this.share()

		return fits
	}

	private setShares(synths: readonly BudgetedSynth[], share: number): void {
		for (const synth of synths) {
			synth.decodedSampleBudget = share
		}
	}
}
