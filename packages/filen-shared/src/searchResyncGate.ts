// Whether a cache search's results may still change because of a resync covering its root.
//
// `Finished` is not the end: the SDK commits the resync's last batch before it, but the window
// re-reads only after its own debounce, and it fires only when its contents or total change, so a
// result that stays empty never fires again. The results are final at the first snapshot after
// `Finished`, or once a refilter (an immediate re-read) reports the total already delivered.
// Delivery of resync messages is best-effort: callers keep their own stall ceiling as a backstop.
export class SearchResyncGate {
	private phase: "idle" | "running" | "finalizing" = "idle"
	private delivered: bigint | null = null
	private epoch = 0
	private readonly onConvergingChange: (converging: boolean) => void

	public constructor(onConvergingChange: (converging: boolean) => void) {
		this.onConvergingChange = onConvergingChange
	}

	public get converging(): boolean {
		return this.phase !== "idle"
	}

	// A resync covering the search root began, or was already running when the search opened.
	public started(): void {
		this.epoch++

		if (this.phase === "idle") {
			this.onConvergingChange(true)
		}

		this.phase = "running"
	}

	// `reread` refilters with the unchanged config and resolves the engine's total; null when no
	// window is installed yet (its first snapshot then settles).
	public finished(reread: (() => Promise<bigint>) | null): void {
		if (this.phase !== "running") {
			return
		}

		const epoch = ++this.epoch

		this.phase = "finalizing"

		if (reread === null) {
			return
		}

		reread().then(
			total => {
				if (epoch === this.epoch && total === this.delivered) {
					this.settle()
				}
			},
			() => {
				if (epoch === this.epoch) {
					this.settle()
				}
			}
		)
	}

	public snapshot(total: bigint): void {
		this.delivered = total

		if (this.phase === "finalizing") {
			this.settle()
		}
	}

	// The search closed: forget it without notifying.
	public reset(): void {
		this.epoch++
		this.phase = "idle"
		this.delivered = null
	}

	private settle(): void {
		if (this.phase !== "finalizing") {
			return
		}

		this.epoch++
		this.phase = "idle"
		this.onConvergingChange(false)
	}
}
