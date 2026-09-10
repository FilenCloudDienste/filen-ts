import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { test as setup, expect, FIXTURES_DIR, FIXTURES_FILE, type FixtureManifest } from "../fixtures"
import { createDirectoryViaDialog, descendInto, waitForListingSettled } from "../helpers/listing"
import { FIXTURE_FILES, type FixtureFileName, type FixtureScenario } from "../helpers/fixtures"
import {
	BMP_BYTES,
	CODE_BYTES,
	DOCX_BYTES,
	DOWNLOAD_CANCEL_BYTES,
	DOWNLOAD_FSA_TEXT,
	DOWNLOAD_SW_TEXT,
	DOWNLOAD_ZIP_A_TEXT,
	DOWNLOAD_ZIP_B_TEXT,
	HEIC_BYTES,
	MP3_BYTES,
	MP4_BYTES,
	PDF_BYTES,
	PDF_LINKS_BYTES,
	PDF_PASSWORD_BYTES,
	PNG_BYTES
} from "../helpers/fixtureBytes"

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

// Inline bytes, or a size to synthesize on disk. The disk form exists for one file: Playwright reads a
// path-based file input straight off local disk into the browser, so a 24 MiB payload never has to
// serialize through the Playwright<->driver bridge as a call argument (the same trick downloads.spec.ts
// used for the same file before this setup took the upload over).
interface InlineFixture {
	readonly buffer: Buffer
	readonly mimeType: string
}

interface DiskFixture {
	readonly filledBytes: number
}

type FixturePayload = InlineFixture | DiskFixture

interface FixtureEntry<TPayload extends FixturePayload> {
	readonly name: FixtureFileName
	readonly payload: TPayload
}

// One entry per name in FIXTURE_FILES — `satisfies Record<FixtureFileName, …>` is what makes that a
// compile error rather than a mid-run "row never appeared" if the two ever drift.
const PAYLOADS = {
	"marquee-0.txt": { buffer: Buffer.from("marquee probe 0"), mimeType: "text/plain" },
	"marquee-1.txt": { buffer: Buffer.from("marquee probe 1"), mimeType: "text/plain" },
	"marquee-2.txt": { buffer: Buffer.from("marquee probe 2"), mimeType: "text/plain" },
	"marquee-3.txt": { buffer: Buffer.from("marquee probe 3"), mimeType: "text/plain" },
	"marquee-4.txt": { buffer: Buffer.from("marquee probe 4"), mimeType: "text/plain" },
	"marquee-5.txt": { buffer: Buffer.from("marquee probe 5"), mimeType: "text/plain" },
	"preview-image-a.png": { buffer: PNG_BYTES, mimeType: "image/png" },
	"preview-image-b.png": { buffer: PNG_BYTES, mimeType: "image/png" },
	"preview-heic.heic": { buffer: HEIC_BYTES, mimeType: "image/heic" },
	"preview-pdf.pdf": { buffer: PDF_BYTES, mimeType: "application/pdf" },
	"preview-pdf-links.pdf": { buffer: PDF_LINKS_BYTES, mimeType: "application/pdf" },
	"preview-pdf-locked.pdf": { buffer: PDF_PASSWORD_BYTES, mimeType: "application/pdf" },
	"preview-media.mp3": { buffer: MP3_BYTES, mimeType: "audio/mpeg" },
	"preview-media.mp4": { buffer: MP4_BYTES, mimeType: "video/mp4" },
	"preview-media.png": { buffer: PNG_BYTES, mimeType: "image/png" },
	"preview-docx.docx": {
		buffer: DOCX_BYTES,
		mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	},
	// video/mp2t is what a browser reports for a .ts file — kept verbatim so the code-preview leg still
	// proves the app routes by EXTENSION and not by the picker's own content-type guess.
	"preview-code.ts": { buffer: CODE_BYTES, mimeType: "video/mp2t" },
	"thumbnails.png": { buffer: PNG_BYTES, mimeType: "image/png" },
	"thumbnails.bmp": { buffer: BMP_BYTES, mimeType: "image/bmp" },
	"thumbnails.txt": { buffer: Buffer.from("not an image", "utf8"), mimeType: "text/plain" },
	"thumbnails.svg": {
		buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8"),
		mimeType: "image/svg+xml"
	},
	"download-fsa.txt": { buffer: Buffer.from(DOWNLOAD_FSA_TEXT, "utf8"), mimeType: "text/plain" },
	"download-zip-a.txt": { buffer: Buffer.from(DOWNLOAD_ZIP_A_TEXT, "utf8"), mimeType: "text/plain" },
	"download-zip-b.txt": { buffer: Buffer.from(DOWNLOAD_ZIP_B_TEXT, "utf8"), mimeType: "text/plain" },
	"download-sw.txt": { buffer: Buffer.from(DOWNLOAD_SW_TEXT, "utf8"), mimeType: "text/plain" },
	"download-cancel.bin": { filledBytes: DOWNLOAD_CANCEL_BYTES }
} satisfies Record<FixtureFileName, FixturePayload>

// ONE wall clock for the whole build, the shape cleanup-setup's SWEEP_BUDGET_MS already uses. Each row
// wait below used to carry a generous pin of its OWN, which across 26 files declared several times the
// 900s project ceiling (playwright.config.ts, fixtures-setup) — so the ceiling could never be what
// stopped a slow build. The harness kill was, and that is the expensive stop: it names nothing, dies
// before the SDK can release the account-wide `drive-write` lease (leaving it orphaned for its full
// TTL), and skips every chromium lane depending on this project.
//
// 360s is about twice what a healthy build spends between the root create and its last upload, and
// leaves the ceiling room for the rest: the root-create loop's own declared worst is 495s (3 attempts x
// 30s goto + 10s settle + 125s create), so 495 + 360 = 855 of 900. The remaining 45s is slack for a
// directory create or descent still in flight when the budget runs out — those are not pinned to it,
// they only spend it.
const UPLOAD_BUDGET_MS = 360_000

// Named rather than left to the pin's own timeout text: the point of a self-imposed budget is that the
// run says which file it was still waiting for, which a harness kill never does.
const budgetExhausted = (name: FixtureFileName): string => `fixtures-setup: upload budget exhausted with "${name}" still missing`

// One upload per scenario through the SAME hidden file input a user's picker drives (uploadMenu.tsx),
// targeting whatever directory the app is currently in — the createTestFile hook cannot be used, it
// uploads at the account root with no parent.
//
// setInputFiles takes EITHER an array of on-disk paths or an array of in-memory payloads, never a mix,
// so a scenario that needs a synthesized file must be entirely on disk. Nothing mixes today; the throw
// makes a future scenario that does fail here instead of silently uploading half its files.
async function uploadScenarioFiles(page: Page, scenario: FixtureScenario, workDir: string, deadline: number): Promise<void> {
	const names: readonly FixtureFileName[] = FIXTURE_FILES[scenario]
	// Name and payload carried together rather than as two index-aligned arrays — the two filters below
	// each drop entries, and an index into the original names would then be pointing at the wrong file.
	const entries: FixtureEntry<FixturePayload>[] = names.map(name => ({ name, payload: PAYLOADS[name] }))
	const onDisk = entries.filter((entry): entry is FixtureEntry<DiskFixture> => "filledBytes" in entry.payload)
	const inline = entries.filter((entry): entry is FixtureEntry<InlineFixture> => "buffer" in entry.payload)

	if (onDisk.length > 0 && inline.length > 0) {
		throw new Error(`fixture scenario "${scenario}" mixes on-disk and in-memory payloads, which setInputFiles cannot take`)
	}

	const input = page.locator('input[type="file"]').first()

	if (onDisk.length > 0) {
		await input.setInputFiles(
			onDisk.map(({ name, payload }) => {
				const path = join(workDir, name)

				writeFileSync(path, "x".repeat(payload.filledBytes))

				return path
			})
		)
	} else {
		await input.setInputFiles(inline.map(({ name, payload }) => ({ name, mimeType: payload.mimeType, buffer: payload.buffer })))
	}

	// Every row, not just the last: uploads run concurrently inside the SDK, so arrival order says
	// nothing, and a scenario that lands three of its four files is exactly the half-built state a
	// later spec would otherwise report as its own mysterious failure.
	const listbox = page.getByRole("listbox", { name: "Directory contents" })

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
// An orderly abort releases it: ResourceLock's Drop posts a Release. A KILLED context does not — the
// wasm runtime dies before Drop runs — so a run torn down mid-write leaves the lease to expire on its
// own, and meanwhile the next writer just waits. It waits silently and effectively forever: contention
// is never an error, only `acquired:false` plus a backoff that runs ~8640 attempts before giving up.
// The dialog sits in its pending state throughout, undismissable by design, so only a reload gets out.
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

			// Same virtualization workaround as enterScratchDirectory/enterFixtureDirectory: a tall
			// viewport makes the virtualizer render every row in one pass, so the descents below always
			// find their row.
			await page.setViewportSize({ width: 1280, height: 8000 })
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

setup("build the shared read-only fixture tree", async ({ page, injectedSession }) => {
	// Same convention as cleanup.setup.ts: proving the session actually came back beats discovering it
	// didn't as an unexplained listing timeout several steps down.
	expect(injectedSession.length).toBeGreaterThan(0)

	const manifest = await createFixtureRoot(page)
	const listbox = page.getByRole("listbox", { name: "Directory contents" })

	// Persisted the moment the root EXISTS, before anything is uploaded into it — a setup that dies
	// half-built still leaves the teardown something to trash. (Belt and braces: the name starts "e2e-",
	// so cleanup-setup's own debris sweep would collect it on the next run regardless.)
	mkdirSync(FIXTURES_DIR, { recursive: true })
	writeFileSync(FIXTURES_FILE, JSON.stringify(manifest))

	await descendInto(page, listbox, manifest.fixtureRoot)

	const workDir = mkdtempSync(join(tmpdir(), "filen-e2e-fixtures-"))
	const breadcrumbHome = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
		name: manifest.fixtureRoot,
		exact: true
	})

	// One deadline for the WHOLE build, not one per scenario: a per-scenario budget only moves the same
	// multiplication down a level. Started once the root exists, so the create loop's retries above are
	// bounded on their own rather than charged against this.
	const uploadDeadline = Date.now() + UPLOAD_BUDGET_MS

	try {
		for (const scenario of Object.keys(FIXTURE_FILES) as FixtureScenario[]) {
			await createDirectoryViaDialog(page, scenario, listbox)
			await descendInto(page, listbox, scenario)
			await uploadScenarioFiles(page, scenario, workDir, uploadDeadline)

			// Back up through the breadcrumb ancestor link rather than page.goBack(): a client-side Link
			// navigation, so the SDK worker/OPFS session this setup depends on stays alive, and it is
			// anchored on the fixture root by NAME instead of on however many history entries the descent
			// happened to push.
			await breadcrumbHome.click()
			await waitForListingSettled(page)
		}
	} finally {
		// The synthesized payloads exist only to be read off disk by the uploads above — and one of them
		// is 24 MiB, which on a dev machine would otherwise accumulate in the OS temp directory once per
		// run. Nothing downstream (fixtures.teardown.ts included) ever reads this tree again.
		rmSync(workDir, { recursive: true, force: true })
	}
})
