import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { fail } from "../../support.ts"
import { acquireDriveLock, type DriveLock, lockPost } from "../driveLock.ts"
import { appPids, describeSample, type OfflineBlock, POLL_MS, type Sample, type Sampler, seconds, startThrough } from "../offlineBlock.ts"
import type { Chain } from "./common.ts"

// P11's third sub-step: the network lost while a launch's first cloud listing waits. The harness holds the account's
// drive-write lock (driveLock.ts) and has written outside the pairs while N was quit, so N's launch must relist and
// every pair waits for the cloud; the block then must take every pair offline (none in error) within 30 s, not leave
// it waiting for a listing that cannot come. The lock is released before the lift, and every pair converges within
// 60 s of it. Holding the lock costs no sign-in: it is the harness session's API key.

const LIVE_OFFLINE_MS = 30_000
const RECOVER_MS = 60_000
// A launch's start and its first pass's wait for the cloud.
const WAITING_MS = 60_000
// Consecutive samples (POLL_MS apart) every pair stays waiting for the cloud before the block.
export const DWELL_SAMPLES = 3

// Every pair waiting for the cloud's listing, none offline or in error.
export function allWaiting(sample: Sample): boolean {
	return sample.pairs > 0 && sample.waiting === sample.pairs && sample.offline === 0 && sample.errors === 0
}

// Why the block did not take every pair offline: a pair still waiting for the cloud is the regression this proves.
export function offlineFailure(sample: Sample): string {
	if (sample.errors > 0) {
		return `${String(sample.errors)} of ${String(sample.pairs)} pairs in error instead of offline`
	}

	if (sample.waiting > 0) {
		return `${String(sample.waiting)} of ${String(sample.pairs)} pairs still waiting for the cloud: the listing's wait does not notice the lost network (the regression)`
	}

	return `${String(sample.offline)} of ${String(sample.pairs)} pairs offline`
}

export async function runListingDrop(chain: Chain, block: OfflineBlock, sampler: Sampler, pin: string): Promise<void> {
	const { findings } = chain
	// What the info findings report, whatever the check's outcome.
	const seen: { lock: DriveLock | null; released: string; toOffline: string | null } = {
		lock: null,
		released: "not acquired",
		toOffline: null
	}

	await findings.check(
		"P11 a drop while the first cloud listing waits: every pair offline within 30 s, none in error; converged within 60 s of the lift",
		async () => {
			sampler.reset()
			await chain.quit("N-before-listing-drop")
			// A write N does not see while quit: its next launch lists the cloud again.
			await chain.cloud.mkdir(`${chain.cloudDir}/relist-${randomBytes(4).toString("hex")}`)

			try {
				const lock = await acquireDriveLock(lockPost(chain.remote.apiKey))

				seen.lock = lock
				await startThrough(chain, block.via, pin)

				const waiting = await sampler.watch(WAITING_MS, current => allWaiting(current) || current.offline > 0 || current.errors > 0)

				if (waiting.hit === null || !allWaiting(waiting.hit)) {
					fail(`staging: not every pair waiting for the cloud within 60 s of the launch: ${describeSample(waiting.last)}`)
				}

				for (let sample = 1; sample < DWELL_SAMPLES; sample++) {
					await sleep(POLL_MS)

					const current = await sampler.sample()

					if (!allWaiting(current)) {
						fail(
							`staging: the wait for the cloud did not hold for ${String(DWELL_SAMPLES)} samples: ${describeSample(current)}`
						)
					}
				}

				const blocked = Date.now()

				await block.block(chain.target, await appPids(chain))

				const offline = await sampler.watch(LIVE_OFFLINE_MS, current => current.offline === current.pairs || current.errors > 0)

				if (offline.hit === null || offline.hit.errors > 0) {
					fail(
						`not every pair offline within 30 s of the block: ${offlineFailure(offline.last)}; ${describeSample(offline.last)}`
					)
				}

				seen.toOffline = seconds(blocked, offline.hit.at)

				if (lock.capped()) {
					fail("staging: the drive-write lock reached its cap before every pair was offline")
				}
			} finally {
				// The lock first: N's listing must not complete through a lifted block while the harness still holds it.
				if (seen.lock !== null) {
					seen.released = await seen.lock.release()
				}

				await block.lift()
			}

			const recovered = await sampler.watch(
				RECOVER_MS,
				current => current.offline === 0 && current.errors === 0 && current.lastErrors === 0 && current.waiting === 0
			)

			if (recovered.hit === null) {
				fail(`not converged within 60 s of the lift: ${describeSample(recovered.last)}`)
			}

			return `every pair waited for the cloud over ${String(DWELL_SAMPLES)} samples, went offline after the block, none in error; converged after the lift`
		}
	)

	findings.info("P11 listing drop: time to offline", seen.toOffline ?? "never")
	findings.info(
		"P11 listing drop: drive-write held",
		seen.lock === null
			? seen.released
			: `${seconds(0, seen.lock.heldMs())}${seen.lock.capped() ? " (cap reached)" : ""}, ${seen.released}; refreshes failed: ${seen.lock.refreshFailures().join(" | ") || "none"}`
	)
}
