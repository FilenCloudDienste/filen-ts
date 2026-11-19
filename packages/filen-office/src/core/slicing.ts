// The slice length of every presentation and text worker scheduler (ms).
export const SLICE_MS = 8

// Long work on a thread that must stay responsive, cut into slices: `pause` gives the host a turn (a
// macrotask, so input and requests are handled meanwhile) once `sliceMs` passed since the last one.
export interface Slicing {
	readonly pause: () => Promise<void>
	readonly sliceMs: number
	readonly now: () => number
}

// One slice clock for consecutive sliced calls (inflate, parse, build): a call given a clock continues the
// slice the previous call started, so a run of short calls still yields every sliceMs.
export class SliceClock implements Slicing {
	readonly sliceMs: number
	readonly now: () => number
	private readonly hostPause: () => Promise<void>
	private started: number
	// The turn under way: calls running side by side (parts read in parallel) share it.
	private turn: Promise<void> | null = null

	constructor(slicing: Slicing) {
		this.sliceMs = slicing.sliceMs
		this.now = slicing.now
		this.hostPause = slicing.pause
		this.started = slicing.now()
	}

	get due(): boolean {
		return this.now() - this.started >= this.sliceMs
	}

	readonly pause = (): Promise<void> => {
		this.turn ??= this.hostPause().then(
			() => {
				this.turn = null
				this.started = this.now()
			},
			(error: unknown) => {
				this.turn = null

				throw error
			}
		)

		return this.turn
	}
}

export function sliceClock(slicing: Slicing): SliceClock {
	return slicing instanceof SliceClock ? slicing : new SliceClock(slicing)
}

// Runs `steps` to its end, giving the host a turn at a yield once `clock`'s slice is up (without a clock, never).
export async function runSliced<T>(steps: Generator<void, T>, clock: SliceClock | undefined): Promise<T> {
	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
		if (clock?.due === true) await clock.pause()
	}
}
