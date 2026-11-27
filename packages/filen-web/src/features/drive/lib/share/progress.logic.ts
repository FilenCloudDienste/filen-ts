import { directoryProgress, type DirectoryProgress } from "@/features/drive/lib/directoryProgress"

// How far a share of N items with M contacts is. A run of one directory with one contact shows that
// share's own phases (reading its tree, then its items shared). Any other run is one fraction over its
// N×M item-contact pairs: a pair is 0 until it settles at 1, and a directory's pair follows its items
// shared in between (its listing counts as 0). The fraction is reported only when the whole percent
// changes, so a run makes at most ~100 reports however often its pairs tick.
export type ShareProgress = { kind: "fraction"; value: number } | { kind: "directory"; progress: DirectoryProgress }

export interface SharePair {
	// A directory pair's listing bytes, of a total the SDK may not know yet.
	bytes: (bytes: number, totalBytes: number | undefined) => void
	// A directory pair's items shared, of its total.
	items: (done: number, total: number) => void
	// Succeeded or failed: done either way. Later progress for it is ignored (its ticks can arrive after
	// its result, on their own message port).
	settle: () => void
}

export function createShareProgress(pairs: number, report: (progress: ShareProgress) => void): (directory: boolean) => SharePair {
	let sum = 0
	let reportedPercent = 0

	function add(delta: number): void {
		sum += delta

		const fraction = pairs === 0 ? 0 : sum / pairs
		const percent = Math.floor(fraction * 100)

		if (percent !== reportedPercent) {
			reportedPercent = percent
			report({ kind: "fraction", value: fraction })
		}
	}

	return directory => {
		let settled = false

		if (directory && pairs === 1) {
			const phases = directoryProgress(progress => {
				if (!settled) {
					report({ kind: "directory", progress })
				}
			})

			// Reading starts with the call, before the SDK's first report.
			report({ kind: "directory", progress: { phase: "reading", fraction: undefined } })

			return {
				bytes: phases.bytes,
				items: phases.items,
				settle: () => {
					settled = true
				}
			}
		}

		let value = 0

		function set(next: number): void {
			if (settled || next <= value) {
				return
			}

			const delta = next - value

			value = next
			add(delta)
		}

		return {
			bytes: () => {
				// The listing moves no pair: only its items count.
			},
			items: (done, total) => {
				if (total > 0) {
					set(Math.min(1, done / total))
				}
			},
			settle: () => {
				set(1)
				settled = true
			}
		}
	}
}
