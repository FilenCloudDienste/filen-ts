import type { TimingBudgets } from "../anim/model"
import { MEDIA_LIMITS } from "../opc/mediaPolicy"
import type { SlideRef } from "./model"

// Hostile-input budgets of every presentation reader and writer. Each is checked while reading or writing, before
// what it bounds is allocated, and refused as tooLarge or tooDeep with the budget named in the refusal's detail.

export interface PresentationBudgets {
	readonly zipEntries: number
	// Per XML part, uncompressed bytes.
	readonly xmlPartBytes: number
	readonly elementDepth: number
	readonly slides: number
	readonly masters: number
	readonly layouts: number
	readonly shapesPerSlide: number
	readonly groupDepth: number
	readonly pathCommandsPerShape: number
	readonly displayItemsPerSlide: number
	readonly pathCommandsPerSlide: number
	readonly runsPerSlide: number
	readonly cellsPerSlide: number
	readonly charactersPerDeck: number
	readonly cellsPerDeck: number
	readonly runsPerBody: number
	readonly cellsPerTable: number
	readonly gridColumns: number
	// Per image, from its header before it is decoded (core/opc/mediaPolicy.ts imageWithinBudget).
	readonly decodedPixels: number
	// Checked where ink strokes are read or inserted; ink is drawn from its fallback picture, no points are read yet.
	readonly inkPointsPerSlide: number
	readonly sections: number
	readonly customShows: number
	readonly authors: number
	readonly timing: TimingBudgets
}

export const DEFAULT_PRESENTATION_BUDGETS: PresentationBudgets = {
	zipEntries: 20_000,
	xmlPartBytes: 64 * 1024 * 1024,
	elementDepth: 256,
	slides: 10_000,
	masters: 1_000,
	layouts: 10_000,
	shapesPerSlide: 20_000,
	groupDepth: 128,
	pathCommandsPerShape: 100_000,
	displayItemsPerSlide: 2_000_000,
	pathCommandsPerSlide: 2_000_000,
	runsPerSlide: 500_000,
	cellsPerSlide: 100_000,
	charactersPerDeck: 50_000_000,
	cellsPerDeck: 1_000_000,
	runsPerBody: 100_000,
	cellsPerTable: 100_000,
	gridColumns: 1_000,
	decodedPixels: MEDIA_LIMITS.decodedPixels,
	inkPointsPerSlide: 1_000_000,
	sections: 10_000,
	customShows: 10_000,
	authors: 100_000,
	timing: {
		nodesPerSlide: 20_000,
		depth: 64,
		motionSegments: 10_000,
		scheduleMs: 24 * 60 * 60 * 1000,
		eventsPerShow: 1_000_000
	}
}

// Running totals of one deck, so per-deck budgets hold across slides parsed lazily, and the per-part totals of the part
// being read. Each parsed part's share is kept by its ref and given back when the part is released (or its read
// fails), so a slide parsed again counts once.
export class DeckTally {
	characters = 0
	cells = 0
	// The part being read (count()): its runs and table cells, against the per-slide budgets.
	partRuns = 0
	partCells = 0
	readonly budgets: PresentationBudgets
	private readonly shares = new Map<SlideRef, { readonly characters: number; readonly cells: number }>()

	constructor(budgets: PresentationBudgets = DEFAULT_PRESENTATION_BUDGETS) {
		this.budgets = budgets
	}

	// Reads one part (synchronously) and keeps what it added to the deck totals as `ref`'s share. A read that throws
	// gives its share back.
	count<T>(ref: SlideRef, read: () => T): T {
		this.release(ref)

		const characters = this.characters
		const cells = this.cells

		this.partRuns = 0
		this.partCells = 0

		try {
			const out = read()

			this.shares.set(ref, { characters: this.characters - characters, cells: this.cells - cells })

			return out
		} catch (error) {
			this.characters = characters
			this.cells = cells

			throw error
		}
	}

	// Gives back a part's share (the part was dropped, or its parse failed after its read).
	release(ref: SlideRef): void {
		const share = this.shares.get(ref)

		if (share === undefined) return

		this.characters -= share.characters
		this.cells -= share.cells
		this.shares.delete(ref)
	}
}
