import type { JsSyncPlan } from "@filen/sdk-rs"

// The engine's page limit.
const PAGE = 1000n
const SAMPLE = 20

export interface PlanCheck {
	uploads: number
	downloads: number
	legacyHits: { count: number; sample: string[] } | null
}

// One walk over a plan's actions for the first-run guard: the transfers (the summary's action count includes the
// adoptions that move nothing), and with `isOldIgnored` the actions on paths the old client's rules kept out of the
// pair — a move counts when either end was hidden — with the first few as a sample.
export function checkPlan(plan: JsSyncPlan, isOldIgnored: ((relPath: string) => boolean) | null): PlanCheck {
	let uploads = 0
	let downloads = 0
	let hits = 0
	const sample: string[] = []

	for (let offset = 0n; ; offset += PAGE) {
		const page = plan.actions(offset, PAGE)

		for (const action of page) {
			const { kind, relPath } = action

			if (kind.tag === "UploadFile") {
				uploads++
			} else if (kind.tag === "DownloadFile") {
				downloads++
			}

			if (
				isOldIgnored !== null &&
				(isOldIgnored(relPath) || ((kind.tag === "MoveRemote" || kind.tag === "MoveLocal") && isOldIgnored(kind.inner.to)))
			) {
				hits++

				if (sample.length < SAMPLE && relPath.length <= 4096) {
					sample.push(relPath)
				}
			}
		}

		if (BigInt(page.length) < PAGE) {
			break
		}
	}

	return { uploads, downloads, legacyHits: isOldIgnored === null ? null : { count: hits, sample } }
}
