import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { errorMessage, fail } from "../../support.ts"
import { acquireDriveLock, type DriveLock, type DriveLockTiming, lockPost } from "../driveLock.ts"
import {
	appPids,
	describeSample,
	liveOfflineMs,
	type OfflineBlock,
	POLL_MS,
	type Sample,
	type Sampler,
	seconds,
	startThrough
} from "../offlineBlock.ts"
import type { Chain } from "./common.ts"

// P11's third sub-step: the network lost while a launch's first cloud listing waits. The harness holds the account's
// drive-write lock (driveLock.ts) and has written outside the pairs while N was quit, so N's launch must relist and
// every pair waits for the cloud; the block then must take every pair offline (none in error) within 30 s (mac x64:
// liveOfflineMs), not leave
// it waiting for a listing that cannot come. The lock is released before the lift; every pair is back online (none
// offline or in error) within 60 s of it, and converged (none waiting, no lastError) within 120 s. Holding the lock
// costs no sign-in: it is the harness session's API key.
//
// drive-write covers the whole account, and every deep entry of a run (and of an overlapping nightly or dispatch)
// shares it: while one entry holds it, every other entry's N waits to write or relist. So the whole of P11 runs in the
// account's P11 turn (P11_TURN, a lock of the harness's own on the same API): no two entries' P11 sub-steps, whose
// windows are 30-60 s, ever overlap a listing drop or each other. Checks outside P11 can still meet a foreign hold of
// up to the cap (150 s, typically a launch plus 40 s): sdk-rs clients of the account already hold drive-write for up
// to 60 s a batch (PASS_LOCK_MAX_HOLD), and the hold's wall-clock window is reported (info) so a timed failure in
// another entry can be matched against it.

// Back online after the lift (none offline, none in error; a pair waiting for the cloud is online): the engine wakes
// on reconnect. The same for P11's other two sub-steps.
export const RECOVER_MS = 60_000
// Converged after the lift: N's next pass must take drive-write again, and the lock has no queue. Another entry's N (or
// its 3.x and rclone writers) can win it first and hold it for a batch of up to 60 s (sdk-rs PASS_LOCK_MAX_HOLD) before
// N retries (every 5 s), so convergence tolerates one foreign hold. The same for P11's other two sub-steps.
export const CONVERGE_MS = RECOVER_MS + 60_000
// A launch's start and its first pass's wait for the cloud.
const WAITING_MS = 60_000
// Consecutive samples (POLL_MS apart) every pair stays waiting for the cloud before the block.
export const DWELL_SAMPLES = 3

// The account's P11 turn: polled every 10 s for up to 40 min (eight deep entries, each P11 a few minutes, plus an
// overlapping run's); a hard cap of 20 min, past P11's longest path, so a stalled entry never keeps the others out.
export const P11_TURN = "filen-desktop-e2e-p11"
export const P11_TURN_TIMING: DriveLockTiming = { pollMs: 10_000, acquireMs: 40 * 60 * 1000, refreshMs: 15_000, capMs: 20 * 60 * 1000 }

// Runs P11 inside the account's turn; when the turn does not come, P11 is skipped with a failed staging check.
export async function inP11Turn(chain: Chain, run: () => Promise<void>): Promise<void> {
	const { findings } = chain
	const started = Date.now()
	const turn: { held: DriveLock | null } = { held: null }

	await findings.check("P11 the account's turn taken (no other entry's P11 at the same time)", async () => {
		turn.held = await acquireDriveLock(lockPost(chain.remote.apiKey), P11_TURN_TIMING, P11_TURN).catch((error: unknown) =>
			fail(`staging: ${errorMessage(error)}`)
		)

		return `after ${seconds(started, Date.now())}`
	})

	const { held } = turn

	if (held === null) {
		return
	}

	try {
		await run()
	} finally {
		const released = await held.release()

		findings.info("P11 the account's turn", `${released}${held.capped() ? " (cap reached: P11 overran it)" : ""}`)
	}
}

// Every pair waiting for the cloud's listing, none offline or in error.
export function allWaiting(sample: Sample): boolean {
	return sample.pairs > 0 && sample.waiting === sample.pairs && sample.offline === 0 && sample.errors === 0
}

// Back online after the lift: none offline, none in error.
export function backOnline(sample: Sample): boolean {
	return sample.offline === 0 && sample.errors === 0
}

// Converged after the lift: back online, none waiting for the cloud, no lastError.
export function converged(sample: Sample): boolean {
	return backOnline(sample) && sample.waiting === 0 && sample.lastErrors === 0
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
	const seen: { lock: DriveLock | null; from: string; released: string; toOffline: string | null; toConverged: string | null } = {
		lock: null,
		from: "",
		released: "not acquired",
		toOffline: null,
		toConverged: null
	}

	await findings.check(
		"P11 a drop while the first cloud listing waits: every pair offline within 30 s (90 s on mac x64), none in error; online within 60 s of the lift, converged within 120 s",
		async () => {
			sampler.reset()
			await chain.quit("N-before-listing-drop")
			// A write N does not see while quit: its next launch lists the cloud again.
			await chain.cloud.mkdir(`${chain.cloudDir}/relist-${randomBytes(4).toString("hex")}`)

			try {
				const lock = await acquireDriveLock(lockPost(chain.remote.apiKey))

				seen.lock = lock
				seen.from = new Date().toISOString()
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

				const window = liveOfflineMs(chain.target.platform, process.arch)
				const offline = await sampler.watch(window, current => current.offline === current.pairs || current.errors > 0)

				if (offline.hit === null || offline.hit.errors > 0) {
					fail(
						`not every pair offline within ${seconds(0, window)} of the block: ${offlineFailure(offline.last)}; ${describeSample(offline.last)}`
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

			const lifted = Date.now()
			const online = await sampler.watch(RECOVER_MS, backOnline)

			if (online.hit === null) {
				fail(`not back online within 60 s of the lift: ${describeSample(online.last)}`)
			}

			const settled = await sampler.watch(Math.max(0, lifted + CONVERGE_MS - Date.now()), converged)

			if (settled.hit === null) {
				fail(`not converged within 120 s of the lift: ${describeSample(settled.last)}`)
			}

			seen.toConverged = seconds(lifted, settled.hit.at)

			return `every pair waited for the cloud over ${String(DWELL_SAMPLES)} samples, went offline after the block, none in error; converged after the lift`
		}
	)

	findings.info("P11 listing drop: time to offline", seen.toOffline ?? "never")
	findings.info("P11 listing drop: time from the lift to converged", seen.toConverged ?? "never")
	findings.info(
		"P11 listing drop: drive-write held",
		seen.lock === null
			? seen.released
			: `from ${seen.from}, ${seconds(0, seen.lock.heldMs())}${seen.lock.capped() ? " (cap reached)" : ""}, ${seen.released}; refreshes failed: ${seen.lock.refreshFailures().join(" | ") || "none"}`
	)
}
