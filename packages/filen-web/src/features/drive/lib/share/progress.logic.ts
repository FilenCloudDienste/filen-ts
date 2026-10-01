// How far a share of N items with M contacts is, as one fraction over its N×M item-contact pairs: a
// pair is 0 until it settles at 1, and a directory's pair follows its bytes in between. Reported only
// when the whole percent changes, so a run makes at most ~100 reports however often its pairs tick.
export interface SharePair {
	// A directory pair's bytes so far, of a total the SDK may not know yet.
	progress: (bytes: number, totalBytes: number | undefined) => void
	// Succeeded or failed: done either way. Later progress for it is ignored (its ticks can arrive after
	// its result, on their own message port).
	settle: () => void
}

export function createShareProgress(pairs: number, report: (fraction: number) => void): () => SharePair {
	let sum = 0
	let reportedPercent = 0

	function add(delta: number): void {
		sum += delta

		const fraction = pairs === 0 ? 0 : sum / pairs
		const percent = Math.floor(fraction * 100)

		if (percent !== reportedPercent) {
			reportedPercent = percent
			report(fraction)
		}
	}

	return () => {
		let value = 0
		let settled = false

		function set(next: number): void {
			if (settled || next <= value) {
				return
			}

			const delta = next - value

			value = next
			add(delta)
		}

		return {
			progress: (bytes, totalBytes) => {
				if (totalBytes !== undefined && totalBytes > 0) {
					set(Math.min(1, bytes / totalBytes))
				}
			},
			settle: () => {
				set(1)
				settled = true
			}
		}
	}
}
