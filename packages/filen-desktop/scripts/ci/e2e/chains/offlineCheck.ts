import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { errorMessage, fail } from "../../support.ts"
import { appPids, createSampler, describeSample, offlineBlockFor, relaunchThrough, type Sampler, startThrough } from "../offlineBlock.ts"
import type { Chain } from "./common.ts"

// P11: N offline and back, with its own processes cut off (offlineBlock.ts) and everything else on the runner online.
//   live drop      with N running: an edit takes its pair offline within 30 s, stays out of the cloud, the sync status
//                  never asks for attention; once the block is lifted the edit uploads and every lastError clears
//                  within 60 s
//   offline start  N launched under the block: every pair offline (none in error), no attention; once lifted, every
//                  pair recovers within 60 s (the engine wakes on reconnect instead of its next periodic pass)
// N runs through the block's wrapper (Linux, macOS) for this check only and is started plainly again after it.

const LIVE_OFFLINE_MS = 30_000
const RECOVER_MS = 60_000
// A launch's own start and first passes before every pair can have tried the network.
const START_OFFLINE_MS = 90_000

export interface OfflineCheckOptions {
	pairs: readonly { name: string; id: string; localRoot: string }[]
	// The pair the offline edit goes into, and its cloud directory.
	editPair: string
	editCloudDir: string
	pin: string
}

// Fails when the sync status asked for attention since the sampler's reset; mounts asking is information.
function noSyncAttention(sampler: Sampler): string {
	const seen = sampler.attentionSeen()

	if (seen.some(rail => rail.includes("Sync, needs attention"))) {
		fail(`the rail asked for attention: ${seen.join(" | ")}`)
	}

	return seen.length === 0 ? "the rail stayed neutral" : `sync never asked for attention (the rail: ${seen.join(" | ")})`
}

export async function runOfflineCheck(chain: Chain, options: OfflineCheckOptions): Promise<void> {
	const { findings, target } = chain
	const block = offlineBlockFor(target)
	const sampler = createSampler(chain, new Set(options.pairs.map(pair => pair.id)))
	const pair = options.pairs.find(candidate => candidate.name === options.editPair) ?? fail(`no pair ${options.editPair}`)
	const inCloud = async (name: string) => (await chain.cloud.list(options.editCloudDir, false))?.some(item => item.path === name) === true

	await findings.must("P11 the offline block prepared", () => block.prepare())

	try {
		if (block.via !== null) {
			await relaunchThrough(chain, "N-before-offline", block.via, options.pin)
		}

		await findings.check("P11 a live drop: an edit goes offline and waits; after the lift it uploads", async () => {
			const name = `offline-${randomBytes(4).toString("hex")}.txt`

			sampler.reset()

			try {
				await block.block(target, await appPids(chain))
				writeFileSync(path.join(pair.localRoot, name), `${name}\n`)

				const offline = await sampler.watch(LIVE_OFFLINE_MS, current => current.phases.includes(`${pair.name}:offline`))

				if (offline.hit === null) {
					fail(`${pair.name} not offline within 30 s of the edit: ${describeSample(offline.last)}`)
				}

				if (await inCloud(name)) {
					fail(`${name} reached the cloud through the block`)
				}
			} finally {
				await block.lift()
			}

			const recovered = await sampler.watch(RECOVER_MS, current => current.offline === 0 && current.lastErrors === 0)

			if (recovered.hit === null || !(await inCloud(name))) {
				fail(
					`not recovered within 60 s of the lift (${name} ${(await inCloud(name)) ? "uploaded" : "not uploaded"}): ${describeSample(recovered.last)}`
				)
			}

			return `offline, ${name} queued; uploaded and every lastError cleared after the lift; ${noSyncAttention(sampler)}`
		})

		await findings.check(
			"P11 a launch while offline: every pair offline, none in error; recovered within 60 s of the lift",
			async () => {
				sampler.reset()
				await chain.quit("N-before-offline-start")

				try {
					await block.block(target, [])
					await startThrough(chain, block.via, options.pin)

					const offline = await sampler.watch(
						START_OFFLINE_MS,
						current => current.offline === current.pairs || current.errors > 0
					)

					if (offline.hit === null || offline.hit.errors > 0) {
						fail(`not every pair offline (or one in error) within 90 s of the launch: ${describeSample(offline.last)}`)
					}
				} finally {
					await block.lift()
				}

				const recovered = await sampler.watch(
					RECOVER_MS,
					current => current.offline === 0 && current.errors === 0 && current.lastErrors === 0
				)

				if (recovered.hit === null) {
					fail(`not recovered within 60 s of the lift: ${describeSample(recovered.last)}`)
				}

				return `every pair offline, none in error; recovered after the lift; ${noSyncAttention(sampler)}`
			}
		)
	} finally {
		findings.info("P11 the block lifted in the end", await block.lift().catch(errorMessage))
		findings.info("P11 halts and lastError texts", sampler.errorsSeen().join(" | ") || "none")

		// The chain goes on with N as it starts it (the wrapper's drive is out of the harness's reach).
		if (block.via !== null || chain.renderer === null) {
			await relaunchThrough(chain, "N-after-offline", null, options.pin)
		}
	}
}
