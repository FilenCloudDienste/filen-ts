import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { errorMessage, fail, onTimeout, waitFor } from "../../support.ts"
import type { Findings } from "../findings.ts"
import {
	acquireDriveLock,
	type DriveLock,
	type DriveLockTiming,
	driveWriteGrants,
	lockPost,
	lockWaitNote,
	orphanedLease,
	outputMark,
	outputSince
} from "../driveLock.ts"
import {
	appPids,
	describeSample,
	type OfflineBlock,
	POLL_MS,
	type Sample,
	type Sampler,
	seconds,
	silentBlock,
	startThrough,
	watchOffline
} from "../offlineBlock.ts"
import { type Chain, LIVE_UPLOAD_MS } from "./common.ts"

// P11's third sub-step: the network lost while a launch's first cloud listing waits. The harness holds the account's
// drive-write lock (driveLock.ts) and has written outside the pairs while N was quit, so N's launch must relist and
// every pair waits for the cloud; the block then must take every pair offline (none in error) within 30 s (mac x64: up
// to the SDK's read timeout is a known bug, watchOffline), not leave it waiting for a listing that cannot come. The
// lock is released before the lift; every pair is back online (none offline or in error) within 60 s of it, and
// converged (none waiting, no lastError) within 120 s. Holding the lock costs no sign-in: it is the harness session's
// API key.
//
// drive-write covers the whole account, and every deep entry of a run (and of an overlapping nightly or dispatch)
// shares it: while one entry holds it, every other entry's N waits to write or relist. So the whole of P11 runs in the
// account's P11 turn (P11_TURN, a lock of the harness's own on the same API): no two entries' P11 sub-steps, whose
// windows are 30-60 s, ever overlap a listing drop or each other; a short live-upload check outside P11 (L14, P4) takes
// the same turn, so it never runs during another entry's drop, whose lost network leaves its lease for the server's
// 60 s TTL. Other checks can still wait for drive-write: the lock has no queue, so the wait is a chain of other
// clients' holds (each up to 60 s a batch, PASS_LOCK_MAX_HOLD, a launch's up to the harness's 150 s cap), bounded by
// time, not by a number of holds. The hold's wall-clock window is reported (info) so a timed failure in another entry
// can be matched against it.

// Back online after the lift (none offline, none in error; a pair waiting for the cloud is online): the engine wakes
// on reconnect. The same for P11's other two sub-steps.
export const RECOVER_MS = 60_000
// Converged after the lift: N's next pass must take drive-write again, and the lock has no queue. Another entry's N (or
// its 3.x and rclone writers) can win it first, and again at every handoff, since N retries only every 5 s; each hold
// is a batch of up to 60 s (sdk-rs PASS_LOCK_MAX_HOLD). The window covers one such hold, not a chain of them: inside the
// P11 turn no other entry drops its network, which is what leaves the longest waits. The same for P11's other two
// sub-steps.
export const CONVERGE_MS = RECOVER_MS + 60_000
// A launch's start and its first pass's wait for the cloud.
const WAITING_MS = 60_000
// Consecutive samples (POLL_MS apart) every pair stays waiting for the cloud before the block.
export const DWELL_SAMPLES = 3

// The account's P11 turn: polled every 10 s for up to 40 min (eight deep entries, each P11 a few minutes, plus an
// overlapping run's); a hard cap of 20 min, past P11's longest path, so a stalled entry never keeps the others out.
export const P11_TURN = "filen-desktop-e2e-p11"
export const P11_TURN_TIMING: DriveLockTiming = { pollMs: 10_000, acquireMs: 40 * 60 * 1000, refreshMs: 15_000, capMs: 20 * 60 * 1000 }

// Runs `run` (P11, or the check named by `step`) inside the account's turn; when the turn does not come, it is skipped
// with a failed staging check. `findings` are the chain's own unless the caller has its own view of them.
export async function inP11Turn(
	chain: Chain,
	run: () => Promise<unknown>,
	{ step = "P11", findings = chain.findings }: { step?: string; findings?: Findings } = {}
): Promise<void> {
	const started = Date.now()
	const turn: { held: DriveLock | null } = { held: null }

	await findings.check(`${step} the account's P11 turn taken (no other entry's P11 at the same time)`, async () => {
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

		findings.info(`${step} the account's P11 turn`, `${released}${held.capped() ? ` (cap reached: ${step} overran it)` : ""}`)
	}
}

// The check `name` (its first word the step): a new file `file` in `localRoot` is in `cloudDir` within LIVE_UPLOAD_MS,
// inside the account's P11 turn, so it never runs during another entry's network drop. On a timeout it says whether N
// was still waiting for drive-write, so a lock wait reads as one and not as a sync bug.
export async function liveEditUploads(
	chain: Chain,
	{ name, file, localRoot, cloudDir, findings = chain.findings }: LiveEdit
): Promise<void> {
	await inP11Turn(
		chain,
		() =>
			findings.check(name, async () => {
				const mark = outputMark(chain.appOutput)

				writeFileSync(path.join(localRoot, file), `${file}\n`)
				await waitFor("the live file in the cloud", LIVE_UPLOAD_MS, async () =>
					(await chain.cloud.list(cloudDir, false))?.some(item => item.path === file) === true ? true : null
				).catch((error: unknown) => fail(`${errorMessage(error)}; ${lockWaitNote(outputSince(chain.appOutput, mark))}`))

				return `${file} uploaded`
			}),
		{ step: name.split(" ")[0] ?? name, findings }
	)
}

export interface LiveEdit {
	name: string
	file: string
	localRoot: string
	cloudDir: string
	findings?: Findings
}

// sdk-rs sends a drive-write release once: one that fails while N is cut off leaves the lease on the server until its
// TTL, which keeps every client of the account, N included, from the lock for up to a minute after the network is back.
export const RELEASE_ISSUE =
	"gap/sdk: a drive-write release that fails in transport is never sent again, so the server keeps the lease for its 60 s TTL (sdk-rs sync/lock release(), from spawn_release: on ErrorKind::Reqwest send it again every LOCK_RETRY_INTERVAL until it succeeds or LOCK_SERVER_TTL has passed since the lease's last confirmation)"
// The least time a lease left by a failed release must still have at the lift for N's next acquire to tell a release
// sent again from the server's TTL.
const ORPHAN_ROOM_MS = 10_000

// After a lift: when N's release of drive-write failed while it was cut off (from `blockedAt`) and the server still
// keeps the lease, whether N got drive-write again before the lease could lapse, which only a release sent again
// allows. `mark` is where the chain's app output stood before the block.
export async function releaseSentAgain(chain: Chain, step: string, mark: number, blockedAt: number, lifted: number): Promise<void> {
	const lease = orphanedLease(outputSince(chain.appOutput, mark), blockedAt, lifted, ORPHAN_ROOM_MS)

	if (lease === null) {
		return
	}

	await chain.findings.known(
		`${step}: a drive-write release that failed offline is sent again once back online`,
		RELEASE_ISSUE,
		async () => {
			const grant = await waitFor(
				"N's drive-write before the lease could lapse",
				Math.max(0, lease.lapsesAt - Date.now()),
				() => driveWriteGrants(outputSince(chain.appOutput, mark)).find(at => at >= lifted && at < lease.lapsesAt),
				500
			).catch(onTimeout(null))
			const times = `the release failed ${seconds(lease.failedAt, lifted)} before the lift; the lease, last confirmed ${seconds(lease.confirmedAt, lifted)} before it, could lapse ${seconds(lifted, lease.lapsesAt)} after it`

			if (grant === null) {
				fail(`N got drive-write again only once the lease could lapse (${times})`)
			}

			return `N got drive-write ${seconds(lifted, grant)} after the lift (${times})`
		}
	)
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
		"P11 a drop while the first cloud listing waits: every pair offline within 30 s, none in error; online within 60 s of the lift, converged within 120 s",
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

				const offline = await watchOffline(
					findings,
					"P11 a listing drop: every pair offline",
					sampler,
					silentBlock(chain.target.platform, process.arch),
					current => current.offline === current.pairs || current.errors > 0
				)

				if (offline.hit === null || offline.hit.errors > 0) {
					fail(
						`not every pair offline within ${seconds(0, offline.capMs)} of the block: ${offlineFailure(offline.last)}; ${describeSample(offline.last)}`
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
