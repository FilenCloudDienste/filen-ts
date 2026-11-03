import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { CLOUD_ROOT, openCloud, runDir, type Cloud } from "./e2e/cloud.ts"
import { createFindings } from "./e2e/findings.ts"
import { fixtureTree, seededBytes, treeSnapshot, writeTree } from "./e2e/fixtures.ts"
import { redactor } from "./e2e/redact.ts"
import { harnessRemote, mask, runId, sealRemote, secretsOf, signInHarness, takeCredentials, writeSealed } from "./e2e/session.ts"
import { cloudSnapshot, diffSnapshots } from "./e2e/snapshot.ts"
import { errorMessage, fail, section } from "./support.ts"

// The desktop e2e's cloud side (see .github/workflows/desktop-e2e.yml), on any runner:
//
//   session    the run's one harness sign-in (sdk-rs), written sealed to the file FILEN_DESKTOP_E2E_SESSION_FILE names
//   selftest   with the handed session: create, list, upload a new version, diff, read back, move and delete a run
//              directory, and read the account's storage
//   sweep      with the handed session: delete this run's directories and any older than a day, then empty the trash
//
//   node scripts/ci/e2eCloud.ts <session|selftest|sweep> [--artifacts <dir>]
//
// Credentials come from FILEN_DESKTOP_E2E_TEST_EMAIL / _PASSWORD, the handed session from the file
// FILEN_DESKTOP_E2E_SESSION_FILE names.

const SWEEP_AGE_MS = 24 * 60 * 60 * 1000
const SWEEP_BUDGET_MS = 3 * 60 * 1000

async function session(): Promise<void> {
	const credentials = takeCredentials()
	const remote = await signInHarness(credentials)
	const sealed = sealRemote(remote, credentials.password, runId())

	mask([sealed])
	writeSealed(sealed)
	console.log("signed in once; the sealed session is in its file, for the artifact")
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
const artifactsAt = process.argv.indexOf("--artifacts")
const artifacts = path.resolve(artifactsAt === -1 ? "e2e-artifacts" : (process.argv[artifactsAt + 1] ?? "e2e-artifacts"))

if (import.meta.main) {
	const work = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-cloud-"))

	try {
		if (command === "session") {
			section("harness sign-in")
			await session()
		} else if (command === "selftest" || command === "sweep") {
			const credentials = takeCredentials()
			const remote = harnessRemote(credentials)
			const cloud = await openCloud(remote, work)

			section(command)

			if (command === "selftest") {
				await selftest(cloud, work, artifacts, redactor([credentials.email, credentials.password, ...secretsOf(remote)]))
			} else {
				await sweep(cloud)
			}
		} else {
			console.error("usage: node scripts/ci/e2eCloud.ts <session|selftest|sweep> [--artifacts <dir>]")
			process.exit(2)
		}
	} catch (error) {
		console.error(`::error::${command ?? ""}: ${errorMessage(error)}`)
		process.exit(1)
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}
