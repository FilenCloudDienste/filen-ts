import { createHash } from "node:crypto"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { CLOUD_ROOT, openCloud, runDir, type Cloud } from "./e2e/cloud.ts"
import { createFindings } from "./e2e/findings.ts"
import { fixtureTree, seededBytes, treeSnapshot, writeTree } from "./e2e/fixtures.ts"
import { redactor } from "./e2e/redact.ts"
import {
	type Credentials,
	harnessSession,
	isSlot,
	mask,
	readCached,
	remoteOf,
	runId,
	secretsOf,
	type SessionRecord,
	signInHarness,
	type Slot,
	slotCredentials,
	SLOTS,
	STALE_AFTER_MS,
	takeCredentials,
	takeSessionKey,
	validateSession,
	writeCached,
	writeHandOff
} from "./e2e/session.ts"
import { cloudSnapshot, diffSnapshots } from "./e2e/snapshot.ts"
import { errorMessage, fail, section } from "./support.ts"

// The desktop e2e's cloud side (see .github/workflows/desktop-e2e.yml), on any runner:
//
//   session    one slot's session for the run (scripts/ci/e2e/session.ts): the cached one if the API still knows it
//              and it is under a week old, else one login (sdk-rs); written sealed to the cache directory when minted
//              and to the run's hand-off directory. Writes minted=true|false to $GITHUB_OUTPUT and nothing else.
//   selftest   with the handed session: create, list, upload a new version, diff, read back, move and delete a run
//              directory, and read the account's storage
//   sweep      with the handed session: delete this run's directories and any older than a day, then empty the trash
//
//   node scripts/ci/e2eCloud.ts <session --slot <test|quota>|selftest|sweep> [--artifacts <dir>]
//
// Credentials come from the slot's secrets (FILEN_DESKTOP_E2E_TEST_EMAIL / _PASSWORD for test), the sealing secret
// from FILEN_DESKTOP_E2E_SESSION_KEY, the cached copy from FILEN_DESKTOP_E2E_CACHE_DIR and the handed session from
// FILEN_DESKTOP_E2E_SESSION_DIR.

const SWEEP_AGE_MS = 24 * 60 * 60 * 1000
const SWEEP_BUDGET_MS = 3 * 60 * 1000

// Why a cached session cannot serve the run (null: it can). An infrastructure failure while asking the API throws.
async function unusable(cached: SessionRecord | null, credentials: Credentials): Promise<string | null> {
	if (cached === null) {
		return "nothing cached"
	}

	if (cached.client.email.toLowerCase() !== credentials.email.toLowerCase()) {
		return "cached for another account"
	}

	if (Date.now() - cached.mintedAt > STALE_AFTER_MS) {
		return "minted a week ago or more"
	}

	const verdict = await validateSession(cached.client)

	return verdict === "valid" ? null : verdict === "unknown-key" ? "the API does not know its key" : "its key is another account's"
}

// Exactly one login when the cache holds no usable session, none otherwise; whether it logged in. A slot without its
// secrets is skipped, except `test`, which every deep entry needs.
async function session(slot: Slot): Promise<boolean> {
	const credentials = slotCredentials(slot)

	if (credentials === null) {
		if (slot === "test") {
			fail(`${SLOTS.test.email} and ${SLOTS.test.password} must be set`)
		}

		console.log(`no secrets for the ${slot} slot; skipped`)

		return false
	}

	const secret = takeSessionKey()
	const cached = readCached(slot, secret)
	const reason = await unusable(cached, credentials)
	let record: SessionRecord

	if (cached !== null && reason === null) {
		record = cached
		mask(secretsOf(remoteOf(record.client)))
		console.log(`the cached ${slot} session is valid (minted ${new Date(record.mintedAt).toISOString()}); no login`)
	} else {
		console.log(`minting the ${slot} session (one login): ${reason ?? "nothing cached"}`)
		record = { client: await signInHarness(credentials), mintedAt: Date.now() }
		writeCached(slot, record, secret)
	}

	writeHandOff(slot, record, secret)
	console.log(`the sealed ${slot} session is in the hand-off directory, for the artifact`)

	return record !== cached
}

async function selftest(cloud: Cloud, work: string, artifacts: string, redact: (text: string) => string): Promise<void> {
	const findings = createFindings("cloud-selftest", artifacts, redact)
	const dir = `${runDir()}/selftest`
	const tree = fixtureTree("selftest", true)
	const seed = path.join(work, "seed")

	writeTree(seed, tree)

	try {
		await findings.must("upload a fixture tree to a new run directory", async () => {
			await cloud.upload(seed, dir)

			return dir
		})
		await findings.check("the directory's uuid is listed", async () => `uuid of ${dir}: ${(await cloud.dirId(dir)).length} characters`)

		const first = await cloudSnapshot(cloud, dir, work)

		await findings.must("the cloud holds the tree byte for byte (empty file and directory included)", () => {
			const differences = diffSnapshots(treeSnapshot(tree), first ?? fail("the directory is gone"), { identity: false })

			if (differences.length > 0) {
				fail(differences.join("; "))
			}

			return `${String(first?.size ?? 0)} entries`
		})

		// A new version of one file: its identity changes, every other one stays.
		const edited = path.join(work, "notes.txt")

		writeFileSync(edited, seededBytes("selftest-edit", 4096))
		await cloud.uploadFile(edited, `${dir}/docs/notes.txt`)

		const second = await cloudSnapshot(cloud, dir, work)

		await findings.check("a new version changes that file's identity only", () => {
			const differences = diffSnapshots(first ?? new Map(), second ?? fail("the directory is gone"), { identity: true })

			if (differences.length !== 1 || !differences[0]?.startsWith("docs/notes.txt: content changed")) {
				fail(`expected one change to docs/notes.txt, got: ${differences.join("; ") || "none"}`)
			}

			return differences[0]
		})
		await findings.check("cat and sha256Of read the new version back", async () => {
			const expected = seededBytes("selftest-edit", 4096)
			const read = await cloud.cat(`${dir}/docs/notes.txt`)
			const digest = await cloud.sha256Of(`${dir}/docs/notes.txt`)

			if (!read.equals(expected)) {
				fail(`cat returned ${String(read.length)} bytes that differ from the ${String(expected.length)} uploaded`)
			}

			if (digest !== createHash("sha256").update(expected).digest("hex")) {
				fail(`sha256Of gave ${digest}`)
			}

			return `${String(read.length)} bytes, sha256 matches`
		})
		await findings.check("moveto renames a file into a new directory, its uuid kept", async () => {
			const before = (await cloud.list(dir))?.find(entry => entry.path === "docs/notes.txt") ?? fail("docs/notes.txt is not listed")

			await cloud.moveto(`${dir}/docs/notes.txt`, `${dir}/moved/renamed.txt`)

			const after = await cloud.list(dir)

			if (after?.some(entry => entry.path === "docs/notes.txt") !== false) {
				fail("docs/notes.txt is still listed")
			}

			const moved = after.find(entry => entry.path === "moved/renamed.txt") ?? fail("moved/renamed.txt is not listed")

			if (moved.id !== before.id) {
				fail("the moved file has another uuid")
			}

			return "moved/renamed.txt, same uuid"
		})
		await findings.check("about reports the account's storage", async () => {
			const usage = await cloud.about()

			if (usage.used === null) {
				fail(`no used figure: ${JSON.stringify(usage)}`)
			}

			return `used ${String(usage.used)}, total ${String(usage.total)}, free ${String(usage.free)}, trashed ${String(usage.trashed)}`
		})
		await findings.check("purge removes the directory", async () => {
			await cloud.purge(dir)

			if ((await cloud.list(dir)) !== null) {
				fail(`${dir} is still listed`)
			}

			return "gone"
		})
		await findings.check("the trash empties", async () => {
			await cloud.emptyTrash()

			return "rclone cleanup succeeded"
		})
	} finally {
		await cloud.purge(dir).catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))
	}

	findings.finish()
}

// This run's directories (every attempt), then any other older than a day, within a time budget; leftovers are
// logged and picked up by the next run.
async function sweep(cloud: Cloud): Promise<void> {
	const deadline = Date.now() + SWEEP_BUDGET_MS
	const entries = (await cloud.list(CLOUD_ROOT, false)) ?? []
	const mine = `${runId()}-`
	const stale = entries.filter(
		entry => entry.isDir && (entry.path.startsWith(mine) || Date.now() - Date.parse(entry.modTime) > SWEEP_AGE_MS)
	)
	const left: string[] = []

	for (const entry of stale) {
		if (Date.now() > deadline) {
			left.push(entry.path)

			continue
		}

		await cloud.purge(`${CLOUD_ROOT}/${entry.path}`)
		console.log(`swept ${entry.path}`)
	}

	if (left.length > 0) {
		console.log(`::warning::sweep budget spent; left for the next run: ${left.join(", ")}`)
	}

	await cloud.emptyTrash()
}

const command = process.argv[2]
const option = (name: string): string | undefined => {
	const at = process.argv.indexOf(name)

	return at === -1 ? undefined : process.argv[at + 1]
}
const artifacts = path.resolve(option("--artifacts") ?? "e2e-artifacts")
const usage = "usage: node scripts/ci/e2eCloud.ts <session --slot <test|quota>|selftest|sweep> [--artifacts <dir>]"

if (import.meta.main) {
	const work = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-cloud-"))

	try {
		if (command === "session") {
			const slot = option("--slot") ?? ""

			if (!isSlot(slot)) {
				console.error(usage)
				process.exit(2)
			}

			section(`${slot} session`)

			const minted = await session(slot)

			if (process.env["GITHUB_OUTPUT"]) {
				appendFileSync(process.env["GITHUB_OUTPUT"], `minted=${String(minted)}\n`)
			}
		} else if (command === "selftest" || command === "sweep") {
			const credentials = takeCredentials()
			const { remote } = harnessSession()
			const cloud = await openCloud(remote, work)

			section(command)

			if (command === "selftest") {
				await selftest(cloud, work, artifacts, redactor([credentials.email, credentials.password, ...secretsOf(remote)]))
			} else {
				await sweep(cloud)
			}
		} else {
			console.error(usage)
			process.exit(2)
		}
	} catch (error) {
		console.error(`::error::${command ?? ""}: ${errorMessage(error)}`)
		process.exit(1)
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}
