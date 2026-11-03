import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { errorMessage, fail, waitFor } from "../../support.ts"
import { pageText, putOffKeysReminder, sessionStatus, signIn, signOut } from "../app.ts"
import { CLOUD_ROOT, type Cloud, type CloudUsage, openCloud } from "../cloud.ts"
import { addPairThroughChooser, describePair, issuesShow, removePair, sha256, sha256File, type ExtraPair, waitPair } from "../extraPair.ts"
import { seededBytes } from "../fixtures.ts"
import { createSampler } from "../offlineBlock.ts"
import { type Credentials, harnessSession, secretsOf, slotCredentials } from "../session.ts"
import { START_TIMEOUT_MS } from "../update.ts"
import type { Chain } from "./common.ts"

// P17: the cloud storage full, on the quota account (session slot `quota`: 20.5 MiB of storage, kept nearly full by a
// permanent filler outside the e2e directory). Linux x64 deb only (the plan's `quota`), after P8's sign-out and before
// the uninstall, with ONE sign-in through the real form on that account, never retried:
//   halted      a local file larger than what is left halts the pair with remoteStorageFull, in error, with attention
//               and the Issues tab saying so; the file stays on disk and never reaches the cloud
//   the rest    a small cloud change still lands on disk meanwhile
//   recovery    with the filler deleted and the trash emptied, the file uploads byte for byte within the engine's
//               backoff (4 minutes), no syncNow; then the account is signed out through the account menu
// Skipped (information) when the quota account's secrets or its session are not there.

const MIB = 1024 * 1024
const FILLER_DIR = `${CLOUD_ROOT}-quota`
const FILLER = `${FILLER_DIR}/filler.bin`
const FILLER_BYTES = 12 * MIB
// What the big file needs beyond what is left.
const OVER_BYTES = 4 * MIB
const PAIR = "e2e-quota"
const BIG = "big.bin"
const USAGE_MS = 2 * 60 * 1000
const CONVERGE_MS = 3 * 60 * 1000
const HALT_MS = 3 * 60 * 1000
const RECOVER_MS = 4 * 60 * 1000
const STALE_MS = 24 * 60 * 60 * 1000
const STORAGE_FULL_TEXT = "Your Filen storage is full"

// Taken out of the environment before anything launches (nothing started from the harness inherits them); null without
// the secrets.
export function takeQuotaCredentials(): Credentials | null {
	return slotCredentials("quota")
}

function freeOf(usage: CloudUsage): number {
	if (usage.free !== null) {
		return usage.free
	}

	return usage.total === null || usage.used === null
		? fail(`about gives no free figure: ${JSON.stringify(usage)}`)
		: usage.total - usage.used
}

// The filler in place and counted by the account's usage; restored when missing.
async function filled(cloud: Cloud, work: string): Promise<string> {
	const present =
		(await cloud.list(FILLER_DIR, false))?.some(entry => entry.path === "filler.bin" && entry.size === FILLER_BYTES) === true

	if (!present) {
		const file = path.join(work, "filler.bin")

		writeFileSync(file, seededBytes("quota-filler", FILLER_BYTES))
		await cloud.uploadFile(file, FILLER)
	}

	const usage = await waitFor("the filler counted in the account's usage", USAGE_MS, async () => {
		const read = await cloud.about()

		return (read.used ?? 0) >= FILLER_BYTES ? read : null
	})

	return `${present ? "filler in place" : "filler restored"}; used ${String(usage.used)} of ${String(usage.total)}`
}

export async function runCloudFullCheck(chain: Chain, credentials: Credentials | null): Promise<void> {
	const { findings } = chain

	if (process.env["E2E_QUOTA"] !== "1") {
		return
	}

	if (credentials === null) {
		findings.info("P17 cloud storage full", "skipped: FILEN_DESKTOP_E2E_QUOTA_EMAIL / _PASSWORD are not set")

		return
	}

	let session: ReturnType<typeof harnessSession>

	try {
		session = harnessSession("quota")
	} catch (error) {
		findings.info("P17 cloud storage full", `skipped: no quota session handed to the run (${errorMessage(error)})`)

		return
	}

	for (const value of [credentials.email, credentials.password, ...secretsOf(session.remote)]) {
		chain.secret(value)
	}

	const work = path.join(chain.work, "quota")
	const cloud = await openCloud(session.remote, work)
	// The chain's own layout, in the quota account.
	const cloudDir = `${chain.cloudDir}/${PAIR}`
	const root = chain.rootOf(PAIR)
	const big: { bytes: Buffer } = { bytes: Buffer.alloc(0) }
	const state: { pair?: ExtraPair; signedIn?: boolean } = {}

	mkdirSync(work, { recursive: true })

	try {
		const ready = await findings.check("P17 the quota account nearly full: the filler counted", async () => {
			// What runs killed before their cleanup left (the sweep reaches the test account only).
			for (const entry of (await cloud.list(CLOUD_ROOT, false)) ?? []) {
				if (entry.isDir && Date.now() - Date.parse(entry.modTime) > STALE_MS) {
					await cloud.purge(`${CLOUD_ROOT}/${entry.path}`)
				}
			}

			await cloud.emptyTrash()

			return filled(cloud, work)
		})

		if (!ready) {
			return
		}

		const signedIn = await findings.check("P17 sign in to the quota account through the 4.x form (one attempt)", async () => {
			await chain.connect()

			try {
				state.signedIn = true

				return await signIn(chain.page(), credentials.email, credentials.password, START_TIMEOUT_MS)
			} catch (error) {
				findings.attach("previous-quota-sign-in-page.txt", await pageText(chain.page(), 4000))

				throw error
			}
		})

		if (!signedIn) {
			return
		}

		findings.info(
			"P17 the master-key reminder after sign-in",
			await putOffKeysReminder(chain.page(), 20_000).then(
				shown => (shown ? "shown; put off" : "not shown within 20 s"),
				(error: unknown) => `shown, not put off: ${errorMessage(error)}`
			)
		)

		// twoWay, so that the cloud's change has a way down while uploads are held.
		const paired = await findings.check("P17 a twoWay pair, in sync", async () => {
			const small = Buffer.from("quota e2e: a small file that fits\n")

			mkdirSync(root, { recursive: true })
			writeFileSync(path.join(root, "small.txt"), small)
			await cloud.mkdir(cloudDir)

			const { id } = (state.pair = await addPairThroughChooser(chain, {
				name: PAIR,
				mode: "twoWay",
				localRoot: root,
				remoteRoot: await cloud.dirId(cloudDir)
			}))

			await waitPair(chain, id, `${PAIR} to converge`, CONVERGE_MS, found => found.phase === "idle" && found.lastSyncedAt !== null)
			await waitFor("small.txt in the cloud", CONVERGE_MS, async () =>
				(await cloud.list(cloudDir, false))?.some(entry => entry.path === "small.txt") === true ? true : null
			)

			return `pair ${id} at ${root}`
		})
		const pair = state.pair

		if (!paired || pair === undefined) {
			return
		}

		const sampler = createSampler(chain, new Set([pair.id]))

		await findings.check(
			"P17 the storage full: halted remoteStorageFull, in error, attention, the Issues text; the file kept, not in the cloud",
			async () => {
				const free = freeOf(await cloud.about())

				big.bytes = seededBytes(`quota/${BIG}`, Math.max(0, free) + OVER_BYTES)
				sampler.reset()
				writeFileSync(path.join(root, BIG), big.bytes)

				const halted = await waitPair(
					chain,
					pair.id,
					`${PAIR} to halt on the full storage`,
					HALT_MS,
					found => found.halted === "remoteStorageFull" && found.phase === "error"
				)
				const attention = await sampler.watch(30_000, sample => sample.syncAttention)

				if (attention.hit === null) {
					fail(`the rail did not ask for attention: "${attention.last.rail}" (${describePair(halted)})`)
				}

				const issues = await issuesShow(chain.page(), PAIR, STORAGE_FULL_TEXT, 60_000)

				if (sha256File(path.join(root, BIG)) !== sha256(big.bytes)) {
					fail(`${BIG} changed on disk`)
				}

				if ((await cloud.list(cloudDir, false))?.some(entry => entry.path === BIG) !== false) {
					fail(`${BIG} is in the cloud`)
				}

				return `${String(Math.round(free / 1024))} KiB free for ${String(Math.round(big.bytes.length / 1024))} KiB: ${describePair(halted)}; rail "${attention.hit.rail}"; ${issues}; ${BIG} kept on disk, not in the cloud`
			}
		)

		await findings.check("P17 a small cloud change still lands while the uploads are held", async () => {
			const name = "from-cloud.txt"
			const bytes = Buffer.from("quota e2e: written in the cloud\n")
			const staged = path.join(work, name)

			writeFileSync(staged, bytes)
			await cloud.uploadFile(staged, `${cloudDir}/${name}`)
			await waitFor(`${name} on disk`, HALT_MS, () => {
				try {
					return sha256File(path.join(root, name)) === sha256(bytes) ? true : null
				} catch {
					return null
				}
			})

			return `${name} downloaded`
		})

		await findings.check("P17 the filler deleted and the trash emptied: the file uploads within 4 min, no syncNow", async () => {
			await cloud.purge(FILLER_DIR)
			await cloud.emptyTrash()

			const freed = Date.now()

			await waitFor("the account's usage to drop", USAGE_MS, async () =>
				freeOf(await cloud.about()) > big.bytes.length + MIB ? true : null
			)
			await waitPair(
				chain,
				pair.id,
				`${PAIR} to recover`,
				Math.max(5000, freed + RECOVER_MS - Date.now()),
				found => found.halted === null
			)
			await waitFor(`${BIG} in the cloud`, Math.max(5000, freed + RECOVER_MS - Date.now()), async () =>
				(await cloud.list(cloudDir, false))?.some(entry => entry.path === BIG && entry.size === big.bytes.length) === true
					? true
					: null
			)

			if ((await cloud.sha256Of(`${cloudDir}/${BIG}`)) !== sha256(big.bytes)) {
				fail(`${BIG} in the cloud differs from the local file`)
			}

			return `uploaded ${String(Math.round((Date.now() - freed) / 1000))} s after the filler went, byte for byte`
		})
	} finally {
		if (state.pair !== undefined) {
			findings.info("P17 the pair removed", await removePair(chain, state.pair.id).catch(errorMessage))
		}

		// A sign-in that never stored the session has nothing to sign out of.
		if (state.signedIn === true && chain.renderer !== null && (await sessionStatus(chain.page()).catch(errorMessage)) === "present") {
			await findings.check("P17 the quota account signed out through the account menu", () =>
				signOut(chain.page(), findings, credentials.email, chain.artifacts, "previous-quota")
			)
		}

		if (chain.launched !== null) {
			await chain.quit("N-quota").catch((error: unknown) => findings.info("P17 N quit", errorMessage(error)))
		}

		// The account as the next run expects it: this run's directory and trash gone, the filler back.
		const cleaned = await cloud
			.purge(cloudDir)
			.then(() => cloud.emptyTrash())
			.then(() => filled(cloud, work))
			.catch(errorMessage)

		findings.info("P17 the quota account cleaned up", cleaned)
	}
}
