import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { test as setup, expect, FIXTURES_DIR, FIXTURES_FILE, type FixtureManifest } from "../fixtures"
import { waitForE2eHooks } from "../helpers/e2eHooks"
import {
	clickCrumb,
	createDirectoryViaDialog,
	descendInto,
	directoryListbox,
	fileInput,
	setTallListingViewport,
	waitForListingSettled
} from "../helpers/listing"
import { FIXTURE_SCENARIOS, FIXTURE_FILES, fixturePayloads, type FixtureFileName, type FixtureScenario } from "../fixtures/registry"
import { splitUpload, type FixturePayload } from "../fixtures/scenarios"

// Builds the ONE shared, read-only fixture tree every non-mutating spec reads from (helpers/fixtures.ts
// explains what it is and why it exists). Runs once per suite, after cleanup-setup, in a single browser
// context — which is the whole point: these creates and uploads all take the account-wide `drive-write`
// lease, and taken back to back by one client they simply queue, whereas the per-test equivalents they
// replace were fired from several parallel workers at once and routinely deadlocked each other
// (playwright.config.ts's lane note has the mechanism).
//
// retries: 0 — a Playwright-level retry would rebuild the whole tree and leak the first one. The one
// failure worth surviving (a stale drive-write lease losing the very first create) is retried inside
// the test instead, where it costs one directory rather than twenty-six uploads.
setup.describe.configure({ retries: 0 })

// ONE wall clock for the whole build, the shape cleanup-setup's SWEEP_BUDGET_MS already uses. Each row
// wait below used to carry a generous pin of its OWN, which across 26 files declared several times the
// project ceiling (playwright.config.ts, fixtures-setup) — so the ceiling could never be what
// stopped a slow build. The harness kill was, and that is the expensive stop: it names nothing, dies
// before the SDK can release the account-wide `drive-write` lease (leaving it orphaned for its full
// TTL), and skips every chromium lane depending on this project.
//
// What a build spends grows with the scenario count, not the bytes: each scenario is a descent, its upload and a
// way back, ~2.5s, where the uploads themselves are well under a second. Its directories are created in one
// call up front rather than one New directory dialog each, which cost ~3s more per scenario (menu, dialog,
// create, the dialog's close): with 76 scenarios that put a healthy build at ~400s, at this budget's edge.
// 420s is about twice what one now spends between the root create and its last upload, and leaves the
// ceiling room for the rest:
// the root-create loop's own declared worst is 495s (3 attempts x 30s goto + 10s settle + 125s create),
// so 495 + 420 = 915 of 960. The remaining 45s is slack for a directory create or descent still in
// flight when the budget runs out — those are not pinned to it, they only spend it.
const UPLOAD_BUDGET_MS = 420_000

// Named rather than left to the pin's own timeout text: the point of a self-imposed budget is that the
// run says which file it was still waiting for, which a harness kill never does.
const budgetExhausted = (name: FixtureFileName): string => `fixtures-setup: upload budget exhausted with "${name}" still missing`

// A page.evaluate has no timeout of its own: bounded by the build's deadline, it fails naming what it waited for
// instead of running into the project ceiling.
async function withinBudget<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined

	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => {
						reject(new Error(message))
					},
					Math.max(0, deadline - Date.now())
				)
			})
		])
	} finally {
		clearTimeout(timer)
	}
}

// One upload per scenario through the SAME hidden file input a user's picker drives (uploadMenu.tsx),
// targeting whatever directory the app is currently in — the createTestFile hook cannot be used, it
// uploads at the account root with no parent.
//
// setInputFiles takes EITHER an array of on-disk paths or an array of in-memory payloads, never a mix, so a
// scenario holding both goes in as two picks of the same input, one per kind. Each pick is its own change event,
// and the input's handler copies its files out before resetting the value, so the second never drops the first.
async function uploadScenarioFiles(
	page: Page,
	scenario: FixtureScenario,
	payloads: Readonly<Record<FixtureFileName, FixturePayload>>,
	workDir: string,
	deadline: number
): Promise<void> {
	const names: readonly FixtureFileName[] = FIXTURE_FILES[scenario]
	const { onDisk, inline } = splitUpload(names, payloads)
	const input = fileInput(page)

	if (onDisk.length > 0) {
		await input.setInputFiles(
			onDisk.map(({ name, payload }) => {
				const path = join(workDir, name)

				writeFileSync(path, "generate" in payload ? payload.generate() : "x".repeat(payload.filledBytes))

				return path
			})
		)
	}

	if (inline.length > 0) {
		await input.setInputFiles(inline.map(({ name, payload }) => ({ name, mimeType: payload.mimeType, buffer: payload.buffer })))
	}

	// Every row, not just the last: uploads run concurrently inside the SDK, so arrival order says
	// nothing, and a scenario that lands three of its four files is exactly the half-built state a
	// later spec would otherwise report as its own mysterious failure.
	const listbox = directoryListbox(page)

	for (const name of names) {
		// What is LEFT of the shared budget, never a fresh figure per file or per scenario — a fresh one
		// multiplies straight back past the project ceiling. Deliberately not clamped to zero either:
		// `timeout: 0` DISABLES a Playwright wait rather than expiring it, so a spent budget has to skip
		// the assertion outright instead of handing the file an unbounded one.
		const remaining = deadline - Date.now()

		if (remaining <= 0) {
			throw new Error(budgetExhausted(name))
		}

		try {
			await expect(listbox.getByRole("option", { name })).toBeVisible({ timeout: remaining })
		} catch (cause) {
			throw new Error(budgetExhausted(name), { cause })
		}
	}
}

// The first write of a run is the one that loses to a stale `drive-write` lease. The lease is
// server-side (TTL 30s, refreshed every 15s by the holding client — filen-rs src/sync/lock.rs:176-186).
// An orderly abort releases it: ResourceLock's Drop posts a Release. A CLOSED context does not — the
// wasm runtime dies before Drop runs — so any context torn down while the SDK holds the lease leaves it
// to expire on its own, and meanwhile the next writer just waits. It waits silently and effectively
// forever: contention is never an error, only `acquired:false` plus a backoff that runs ~8640 attempts
// before giving up. The dialog sits in its pending state throughout, undismissable by design, so only a
// reload gets out. This is not limited to a run killed mid-write: an ordinary test whose context closes
// does it too, which is why the first write of EVERY spec pays for the previous one (35-72s measured —
// helpers/listing.ts's LIVE_WRITE_TIMEOUT_MS note carries the numbers and the method).
//
// That used to cost the one test that hit it. It now gates every chromium lane, so the same wedge
// would skip the whole suite — which is why this one create gets attempts the rest of the build does
// not. Retrying is the right shape here rather than a longer wait: a dead holder's lease clears on its
// own within the TTL, so a later attempt genuinely can win where waiting on the same one cannot.
//
// A FRESH NAME per attempt, not the same one retried: an abandoned attempt can still land server-side
// afterwards, and a same-name retry would then either collide or leave two identically named rows for
// descendInto to trip over. An abandoned uuid'd root is just debris, and "e2e-" is exactly what
// cleanup-setup's sweep collects on the next run.
const ROOT_CREATE_ATTEMPTS = 3

async function createFixtureRoot(page: Page): Promise<FixtureManifest> {
	let lastError: unknown

	for (let attempt = 1; attempt <= ROOT_CREATE_ATTEMPTS; attempt += 1) {
		const runId = crypto.randomUUID()
		const manifest: FixtureManifest = { runId, fixtureRoot: `e2e-fixtures-${runId}` }

		try {
			// The WHOLE per-attempt sequence sits inside the try, the navigation and the settle included:
			// the goto IS this loop's reload (a wedged dialog holds the app modal and inert, so nothing on
			// the page is reachable until the document is thrown away), and waitForListingSettled throws
			// outright on the listing's error state — a listing that failed to load being exactly what the
			// next attempt's fresh document fixes. Outside, either throw would skip the retry machinery
			// entirely and fail on attempt 1, taking every chromium lane with it (Playwright does not
			// schedule a project whose dependency failed).
			await page.goto("/drive")
			await setTallListingViewport(page)
			await waitForListingSettled(page)

			await createDirectoryViaDialog(page, manifest.fixtureRoot)

			return manifest
		} catch (error) {
			lastError = error

			console.log(
				`fixtures-setup: root create attempt ${String(attempt)} of ${String(ROOT_CREATE_ATTEMPTS)} did not land — ${String(error)}`
			)
		}
	}

	throw new Error(
		`fixtures-setup could not create its root directory in ${String(ROOT_CREATE_ATTEMPTS)} attempts — the account's drive-write lease looks orphaned by an earlier run`,
		{ cause: lastError }
	)
}

setup("build the shared read-only fixture tree", async ({ page }) => {
	const payloads = fixturePayloads()
	const manifest = await createFixtureRoot(page)
	const listbox = directoryListbox(page)

	// Persisted the moment the root EXISTS, before anything is uploaded into it — a setup that dies
	// half-built still leaves the teardown something to trash. (Belt and braces: the name starts "e2e-",
	// so cleanup-setup's own debris sweep would collect it on the next run regardless.)
	mkdirSync(FIXTURES_DIR, { recursive: true })
	writeFileSync(FIXTURES_FILE, JSON.stringify(manifest))

	await descendInto(page, listbox, manifest.fixtureRoot)

	// The New directory dialog's own create, without its dialog: the rows show as they would (the listing is
	// patched). The dialog itself is covered by the specs that test it; here it was most of the build's time.
	const rootUuid = new URL(page.url()).pathname.split("/").at(-1) ?? ""

	expect(rootUuid, "the fixture root's uuid, the last segment of its listing's URL").toMatch(/^[0-9a-f-]{36}$/)

	// One deadline for the WHOLE build, not one per scenario: a per-scenario budget only moves the same
	// multiplication down a level. Started once the root exists, so the create loop's retries above are
	// bounded on their own rather than charged against this.
	const uploadDeadline = Date.now() + UPLOAD_BUDGET_MS
	const workDir = mkdtempSync(join(tmpdir(), "filen-e2e-fixtures-"))

	try {
		await waitForE2eHooks(page)
		await withinBudget(
			page.evaluate(
				async ({ parentUuid, names }) => {
					await window.__filenE2E.createTestDirectories(parentUuid, names)
				},
				{ parentUuid: rootUuid, names: [...FIXTURE_SCENARIOS] }
			),
			uploadDeadline,
			"fixtures-setup: upload budget exhausted creating the scenario directories"
		)

		for (const scenario of FIXTURE_SCENARIOS) {
			await descendInto(page, listbox, scenario)
			await uploadScenarioFiles(page, scenario, payloads, workDir, uploadDeadline)

			// Back up through the breadcrumb ancestor link rather than page.goBack(): a client-side Link
			// navigation, so the SDK worker/OPFS session this setup depends on stays alive, and it is
			// anchored on the fixture root by NAME instead of on however many history entries the descent
			// happened to push.
			await clickCrumb(page, manifest.fixtureRoot)
			await waitForListingSettled(page)
		}
	} finally {
		// The synthesized payloads exist only to be read off disk by the uploads above — and one of them
		// is 24 MiB, which on a dev machine would otherwise accumulate in the OS temp directory once per
		// run. Nothing downstream (fixtures.teardown.ts included) ever reads this tree again.
		rmSync(workDir, { recursive: true, force: true })
	}
})
