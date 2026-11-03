import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { errorMessage, fail } from "../../support.ts"
import { outputMark } from "../driveLock.ts"
import {
	appPids,
	createSampler,
	describeSample,
	LIVE_OFFLINE_MS,
	offlineBlockFor,
	POLL_MS,
	relaunchThrough,
	type Sampler,
	seconds,
	startThrough
} from "../offlineBlock.ts"
import type { Chain } from "./common.ts"
import { backOnline, CONVERGE_MS, converged, RECOVER_MS, releaseSentAgain, runListingDrop } from "./offlineListing.ts"

// P11: N offline and back, with its own processes cut off (offlineBlock.ts) and everything else on the runner online.
//   live drop      with N running and every pair converged: an edit takes its pair offline within 30 s, stays out of
//                  the cloud, the sync status never asks for attention; once the block is lifted every pair is back
//                  online (none offline or in error) within 60 s, and the edit uploads and every pair converges (none waiting, no lastError) within 120 s
//   offline start  N launched under the block: every pair offline (none in error), no attention; once lifted, every
//                  pair is back online within 60 s (the engine wakes on reconnect instead of its next periodic pass)
//                  and converged within 120 s
//   listing drop   N launched to a relist while the harness holds drive-write: every pair waits for the cloud; the
//                  block takes every pair offline (none in error, none still waiting) within 30 s; the lock released,
//                  then the block lifted, every pair online within 60 s and converged within 120 s (offlineListing.ts)
// N runs through the block's wrapper (Linux, macOS) for this check only and is started plainly again after it. The
// convergence windows tolerate one foreign drive-write hold (offlineListing.ts, CONVERGE_MS); the time each sub-step
// took to converge is reported (info). When the live drop cut N off while it held drive-write and its release failed,
// N's next drive-write before the server could let that lease lapse proves the release was sent again; until sdk-rs
// does, that is a known bug (offlineListing.ts RELEASE_ISSUE).

// A launch's own start and first passes before every pair can have tried the network.
const START_OFFLINE_MS = 90_000

export interface OfflineCheckOptions {
	pairs: readonly { name: string; id: string; localRoot: string }[]
	// The pair the offline edit goes into, and its cloud directory.
	editPair: string
	editCloudDir: string
	pin: string
}

// Back online within RECOVER_MS of `lifted`, then converged with `done` true (`what`, when named, says what it waits
// for) within CONVERGE_MS of it; returns the time from the lift to converged.
async function recover(sampler: Sampler, lifted: number, what: string, done: () => Promise<boolean>): Promise<string> {
	const online = await sampler.watch(Math.max(0, lifted + RECOVER_MS - Date.now()), backOnline)

	if (online.hit === null) {
		fail(`not back online within ${seconds(0, RECOVER_MS)} of the lift: ${describeSample(online.last)}`)
	}

	let last = online.hit
	let finished = false

	for (;;) {
		finished ||= await done()

		if (finished && converged(last)) {
			return seconds(lifted, last.at)
		}

		if (Date.now() >= lifted + CONVERGE_MS) {
			const state = what === "" ? "" : ` (${finished ? what : `not ${what}`})`

			fail(`not converged within ${seconds(0, CONVERGE_MS)} of the lift${state}: ${describeSample(last)}`)
		}

		await sleep(POLL_MS)
		last = await sampler.sample()
	}
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
	// Each sub-step's time from the lift to converged, reported whatever its outcome.
	const toConverged: { live: string | null; start: string | null } = { live: null, start: null }

	await findings.must("P11 the offline block prepared", () => block.prepare())

	try {
		if (block.via !== null) {
			await relaunchThrough(chain, "N-before-offline", block.via, options.pin)
		}

		await findings.check("P11 a live drop: an edit goes offline and waits; after the lift it uploads", async () => {
			const name = `offline-${randomBytes(4).toString("hex")}.txt`

			sampler.reset()

			// From settled pairs, so the drop meets no launch's first cloud listing (the listing drop's own sub-step).
			const settled = await sampler.watch(CONVERGE_MS, converged)

			if (settled.hit === null) {
				fail(`not converged before the drop: ${describeSample(settled.last)}`)
			}

			const mark = outputMark(chain.appOutput)
			let blockedAt: number

			try {
				await block.block(target, await appPids(chain))
				blockedAt = Date.now()
				writeFileSync(path.join(pair.localRoot, name), `${name}\n`)

				const offline = await sampler.watch(LIVE_OFFLINE_MS, current => current.phases.includes(`${pair.name}:offline`))

				if (offline.hit === null) {
					fail(`${pair.name} not offline within ${seconds(0, LIVE_OFFLINE_MS)} of the edit: ${describeSample(offline.last)}`)
				}

				if (await inCloud(name)) {
					fail(`${name} reached the cloud through the block`)
				}
			} finally {
				await block.lift()
			}

			const lifted = Date.now()

			// Back online clears the offline halt before the pass that uploads the edit has finished.
			toConverged.live = await recover(sampler, lifted, `${name} uploaded`, () => inCloud(name).catch(() => false))
			await releaseSentAgain(chain, "P11 a live drop", mark, blockedAt, lifted)

			return `offline, ${name} queued; back online, uploaded and converged after the lift; ${noSyncAttention(sampler)}`
		})

		await findings.check(
			"P11 a launch while offline: every pair offline, none in error; online within 60 s of the lift, converged within 120 s",
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

				toConverged.start = await recover(sampler, Date.now(), "", () => Promise.resolve(true))

				return `every pair offline, none in error; back online and converged after the lift; ${noSyncAttention(sampler)}`
			}
		)

		await runListingDrop(chain, block, sampler, options.pin)
	} finally {
		findings.info("P11 live drop: time from the lift to converged", toConverged.live ?? "never")
		findings.info("P11 launch while offline: time from the lift to converged", toConverged.start ?? "never")
		findings.info("P11 the block lifted in the end", await block.lift().catch(errorMessage))
		findings.info("P11 halts and lastError texts", sampler.errorsSeen().join(" | ") || "none")

		// The chain goes on with N as it starts it (the wrapper's drive is out of the harness's reach).
		if (block.via !== null || chain.renderer === null) {
			await relaunchThrough(chain, "N-after-offline", null, options.pin)
		}
	}
}
