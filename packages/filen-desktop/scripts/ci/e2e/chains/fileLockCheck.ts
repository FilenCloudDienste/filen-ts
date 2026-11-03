import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DesktopSyncPlan, DesktopSyncPlanPage, DesktopSyncResult, DesktopSyncUnsyncable } from "@filen/shared/desktop"
import { errorMessage, fail, waitFor } from "../../support.ts"
import { desktop, desktopCall } from "../app.ts"
import { describePair, pairOf, sha256, sha256File, syncNow, waitPair, watchPairs } from "../extraPair.ts"
import { type FileLock, lockFile } from "../fileLock.ts"
import { seededBytes } from "../fixtures.ts"
import { createSampler } from "../offlineBlock.ts"
import { json, ok, type Chain } from "./common.ts"

// P16 (Windows): files another program holds open without sharing (fileLock.ts), in the chain's twoWay pair:
//   new file     a locked new file does not upload while locked; the pair's other files still sync, nothing halts;
//                after the unlock and a syncNow it uploads byte for byte
//   newer cloud  a locked synced file whose cloud copy is newer keeps its local bytes while locked, with no conflict,
//                and its failed passes shelve it (repeatedFailure in the plan's unsyncable list); after the unlock and
//                the Issues tab's Retry it is replaced by the cloud's
//   deleted      a locked synced file whose cloud copy is gone stays while locked; after the unlock the deletion applies
//   left clean   the locked files gone on both sides and the pair without issues, whatever failed above
// Information: what the engine reports for the locked paths and whether the sync status asked for attention
// meanwhile. N runs as the chain started it; nothing signs in.

const KIB = 1024
const SYNC_MS = 2 * 60 * 1000
// How long a lock is held while the engine has its passes at it.
const LOCKED_PASSES_MS = 45_000
// The failed passes after which the engine keeps a path out of its plans (sdk-rs MAX_PATH_FAILURES).
const SHELVING_FAILURES = 3
// Every file the checks lock is named so.
const LOCKED_PREFIX = "locked-"

export interface FileLockOptions {
	pair: { name: string; id: string; localRoot: string }
	cloudDir: string
}

// The unsyncable entries of the pair's dry run; null without a plan.
async function unsyncable(chain: Chain, pairId: string): Promise<DesktopSyncUnsyncable[] | null> {
	const plan = ok(
		"plan",
		await desktop<DesktopSyncResult<DesktopSyncPlan | null>>(chain.page(), `window.desktop.sync.plan(${json(pairId)})`)
	)

	if (plan === null) {
		return null
	}

	try {
		const page = ok(
			"planPage",
			await desktop<DesktopSyncResult<DesktopSyncPlanPage>>(
				chain.page(),
				`window.desktop.sync.planPage(${json(plan.planId)}, "unsyncable", 0, 20)`
			)
		)
		return page.list === "unsyncable" ? page.entries : []
	} finally {
		await desktopCall(chain.page(), `window.desktop.sync.releasePlan(${json(plan.planId)})`)
	}
}

function describeUnsyncable(entries: readonly DesktopSyncUnsyncable[] | null): string {
	if (entries === null) {
		return "no plan"
	}

	return (
		entries.map(entry => `${entry.relPath}: ${entry.reason}${entry.detail === null ? "" : ` (${entry.detail})`}`).join(", ") || "none"
	)
}

export async function runFileLockCheck(chain: Chain, options: FileLockOptions): Promise<void> {
	const { findings, cloud } = chain
	const { pair, cloudDir } = options
	const sampler = createSampler(chain, new Set([pair.id]))
	const local = (name: string) => path.join(pair.localRoot, name)
	const inCloud = async (name: string) => (await cloud.list(cloudDir, false))?.find(item => item.path === name && !item.isDir) ?? null
	const unique = (label: string) => `${label}-${randomBytes(4).toString("hex")}.bin`
	const locks: FileLock[] = []
	const lock = async (file: string, fill: string | null = null) => {
		const held = await lockFile(file, fill)

		locks.push(held)

		return held
	}
	// A file synced both ways before it is locked.
	const synced = async (label: string): Promise<{ name: string; bytes: Buffer }> => {
		const name = unique(label)
		const bytes = seededBytes(name, 32 * KIB)

		writeFileSync(local(name), bytes)
		await waitFor(`${name} in the cloud`, SYNC_MS, async () => ((await inCloud(name)) === null ? null : true))

		return { name, bytes }
	}
	const retryPath = async (relPath: string): Promise<void> => {
		ok(
			"retryPath",
			await desktop<DesktopSyncResult<null>>(chain.page(), `window.desktop.sync.retryPath(${json(pair.id)}, ${json(relPath)})`)
		)
	}
	// The engine had its go at the pair: a syncNow and a completed pass after it.
	const passed = async (): Promise<void> => {
		const since = Date.now()

		await syncNow(chain, pair.id)
		await waitFor("a completed pass", SYNC_MS, async () => {
			const read = await pairOf(chain, pair.id)

			return read.phase !== "syncing" && (read.lastSyncedAt ?? 0) >= since ? true : null
		})
	}

	sampler.reset()

	const watch = watchPairs(sampler)

	try {
		await findings.check("P16 a locked new file: the others sync, nothing halts; it uploads after the unlock", async () => {
			const name = unique("locked-new")
			const bytes = seededBytes(name, 48 * KIB)
			const staged = path.join(chain.work, name)

			writeFileSync(staged, bytes)

			const held = await lock(local(name), staged)
			const other = unique("unlocked")

			writeFileSync(local(other), seededBytes(other, 16 * KIB))
			await waitFor(`${other} in the cloud`, SYNC_MS, async () => ((await inCloud(other)) === null ? null : true))
			await passed()

			const whileLocked = await pairOf(chain, pair.id)

			if ((await inCloud(name)) !== null) {
				fail(`${name} reached the cloud while locked`)
			}

			if (whileLocked.halted !== null || whileLocked.phase === "error") {
				fail(`the pair halted: ${describePair(whileLocked)}`)
			}

			findings.info(
				"P16 the engine on a locked new file",
				`${describePair(whileLocked)}; unsyncable: ${describeUnsyncable(await unsyncable(chain, pair.id))}`
			)
			await held.release()
			await passed()

			const uploaded = await waitFor(`${name} in the cloud`, SYNC_MS, () => inCloud(name))

			if ((await cloud.sha256Of(`${cloudDir}/${name}`)) !== sha256(bytes)) {
				fail(`${name} in the cloud differs (${String(uploaded.size)} bytes)`)
			}

			return `${other} synced and nothing halted while ${name} was locked; it uploaded byte for byte after the unlock`
		})

		await findings.check(
			"P16 a locked file with a newer cloud copy: kept while locked, no conflict; replaced after the unlock",
			async () => {
				const { name, bytes } = await synced("locked-newer")
				const newer = seededBytes(`${name}-newer`, 40 * KIB)
				const staged = path.join(chain.work, `${name}-newer`)
				const held = await lock(local(name))

				writeFileSync(staged, newer)
				await cloud.uploadFile(staged, `${cloudDir}/${name}`)
				// A few passes at the locked file, each asked for and waited on, at least as many as shelve it.
				for (let passes = 0, until = Date.now() + LOCKED_PASSES_MS; passes < SHELVING_FAILURES || Date.now() < until; passes++) {
					await passed()
				}

				const kept = await held.hash()
				const whileLocked = await pairOf(chain, pair.id)

				if (kept !== sha256(bytes)) {
					fail(`the local bytes changed while locked (${kept})`)
				}

				if (whileLocked.issues.conflicts > 0) {
					fail(`a conflict while locked: ${describePair(whileLocked)}`)
				}

				const entries = await unsyncable(chain, pair.id)

				findings.info(
					"P16 the engine on a locked file with a newer cloud copy",
					`${describePair(whileLocked)}; unsyncable: ${describeUnsyncable(entries)}`
				)

				// Every pass failed on the lock, so the engine shelves the path until a success, a retry or an hour.
				if (entries?.some(entry => entry.relPath === name && entry.reason === "repeatedFailure") !== true) {
					fail(`${name} not shelved as a repeatedFailure after its locked passes: ${describeUnsyncable(entries)}`)
				}

				await held.release()
				// What a user does from the Issues tab once the other program let go: Retry, which asks for a pass.
				await retryPath(name)
				await passed()
				await waitFor(`${name} replaced by the cloud's`, SYNC_MS, () => (sha256File(local(name)) === sha256(newer) ? true : null))

				const after = await pairOf(chain, pair.id)

				if (after.issues.conflicts > 0) {
					fail(`a conflict after the unlock: ${describePair(after)}`)
				}

				return "the local bytes kept while locked, no conflict; the cloud's copy landed after the unlock"
			}
		)

		await findings.check("P16 a locked file deleted in the cloud: the deletion applies after the unlock", async () => {
			const { name } = await synced("locked-deleted")
			const held = await lock(local(name))

			// Out of the pair in the cloud (into the chain's own directory): a deletion as the pair sees it.
			await cloud.moveto(`${cloudDir}/${name}`, `${chain.cloudDir}/moved-out/${name}`)
			await passed()

			if (!existsSync(local(name))) {
				fail(`${name} went while locked`)
			}

			findings.info("P16 the engine on a locked file deleted in the cloud", describePair(await pairOf(chain, pair.id)))
			await held.release()
			await passed()
			await waitFor(`${name} deleted on disk`, SYNC_MS, () => (existsSync(local(name)) ? null : true))

			return `${name} kept while locked, deleted after the unlock`
		})
	} finally {
		for (const held of locks) {
			await held.release().catch((error: unknown) => console.log(`lock release: ${errorMessage(error)}`))
		}

		const seen = await watch.stop()

		findings.info(
			"P16 attention while files were locked",
			seen.attention === null ? `none in ${String(seen.samples)} samples` : `the rail: ${seen.attention}`
		)
		findings.info("P16 halts and lastError texts", sampler.errorsSeen().join(" | ") || "none")
		// The checks after this one run in the same pair: none inherits a failed case's files or issues.
		await findings.check("P16 the pair left clean", async () => {
			const left = readdirSync(pair.localRoot).filter(name => name.startsWith(LOCKED_PREFIX))
			const leftInCloud = ((await cloud.list(cloudDir, false)) ?? [])
				.filter(item => !item.isDir && item.path.startsWith(LOCKED_PREFIX))
				.map(item => item.path)

			ok("retryAll", await desktop<DesktopSyncResult<null>>(chain.page(), `window.desktop.sync.retryAll(${json(pair.id)})`))

			for (const name of leftInCloud) {
				await cloud.moveto(`${cloudDir}/${name}`, `${chain.cloudDir}/moved-out/${name}`)
			}

			for (const name of left) {
				rmSync(local(name), { force: true })
			}

			await passed()

			const clean = await waitPair(
				chain,
				pair.id,
				`${pair.name} without issues`,
				SYNC_MS,
				found => found.phase === "idle" && found.issues.unsyncable === 0 && found.issues.failed === 0
			)

			return `${String(new Set([...left, ...leftInCloud]).size)} locked-* files removed; ${describePair(clean)}`
		})
	}
}
