import type { JsSyncPlan } from "@filen/sdk-rs"
import type { NativeSdk } from "./addon.ts"

// The engine's page limit.
const PAGE = 1000n

export interface PlanOverwrites {
	files: number
	bytes: number
}

export interface PlanCheck {
	uploads: number
	downloads: number
	overwrites: PlanOverwrites
}

// One walk over a plan's actions for the first-run guard: the transfers (the summary's action count includes the
// adoptions that move nothing), and those that replace a file the destination holds.
export function checkPlan(sdk: NativeSdk, plan: JsSyncPlan): PlanCheck {
	let uploads = 0
	let downloads = 0
	const overwrites: PlanOverwrites = { files: 0, bytes: 0 }

	for (let offset = 0n; ; offset += PAGE) {
		const page = plan.actions(offset, PAGE)

		for (const action of page) {
			const { tag } = action.kind

			if (tag !== "UploadFile" && tag !== "DownloadFile") {
				continue
			}

			if (tag === "UploadFile") {
				uploads++
			} else {
				downloads++
			}

			if (action.transfer === sdk.PlannedTransfer.Replace) {
				overwrites.files++
				overwrites.bytes += Number(action.size ?? 0n)
			}
		}

		if (BigInt(page.length) < PAGE) {
			break
		}
	}

	return { uploads, downloads, overwrites }
}
