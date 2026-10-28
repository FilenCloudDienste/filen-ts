import { lstat } from "node:fs/promises"
import path from "node:path"
import type { JsSyncPlan } from "@filen/sdk-rs"

// The engine's page limit.
const PAGE = 1000n

export interface PlanOverwrites {
	files: number
	bytes: number
}

export interface PlanCheck {
	uploads: number
	downloads: number
	overwrites: PlanOverwrites | null
}

// Where a one-way pair's transfers land: the cloud, or this device's directory.
export type OverwriteTarget = { side: "remote" } | { side: "local"; localRoot: string }

async function exists(file: string): Promise<boolean> {
	try {
		await lstat(file)

		return true
	} catch {
		return false
	}
}

// One walk over a plan's actions for the first-run guard: the transfers (the summary's action count includes the
// adoptions that move nothing), and with `target` the transfers onto paths the destination may already hold. A
// download counts when the local path exists; an upload always does, as the plan does not tell a new remote file from
// a replaced one.
export async function checkPlan(plan: JsSyncPlan, target: OverwriteTarget | null): Promise<PlanCheck> {
	let uploads = 0
	let downloads = 0
	const overwrites: PlanOverwrites = { files: 0, bytes: 0 }

	for (let offset = 0n; ; offset += PAGE) {
		const page = plan.actions(offset, PAGE)
		const replaced: Promise<boolean>[] = []
		const sizes: number[] = []

		for (const action of page) {
			const { kind, relPath, size } = action

			if (kind.tag === "UploadFile") {
				uploads++

				if (target?.side === "remote") {
					replaced.push(Promise.resolve(true))
					sizes.push(Number(size ?? 0n))
				}
			} else if (kind.tag === "DownloadFile") {
				downloads++

				if (target?.side === "local") {
					replaced.push(exists(path.join(target.localRoot, ...relPath.split("/"))))
					sizes.push(Number(size ?? 0n))
				}
			}
		}

		for (const [index, hit] of (await Promise.all(replaced)).entries()) {
			if (hit) {
				overwrites.files++
				overwrites.bytes += sizes[index] ?? 0
			}
		}

		if (BigInt(page.length) < PAGE) {
			break
		}
	}

	return { uploads, downloads, overwrites: target === null ? null : overwrites }
}
