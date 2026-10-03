import type { Page } from "@playwright/test"
import { formatBytes } from "@filen/shared"
import { test, expect, readFixtureManifest } from "./fixtures"
import type { ArchiveCatalogueRow } from "./global"
import {
	deleteConfirm,
	openArchive,
	openCompressDialog,
	openExtractDialog,
	openRowMenu,
	openSubmenu,
	selectionBar,
	selectRows,
	setArchiveMemory,
	type CompressDialogPO
} from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { bootTo, breadcrumb, descendInto, dismissOverlays, waitForListingSettled, type ListingHandle } from "./helpers/listing"
import { setAppOffline } from "./helpers/offline"

// The compress and extract dialogs and the menus that open them, over the shared read-only fixture
// tree. Nothing here ever reaches the SDK's job API: every dialog ends with Cancel, every submit made
// is one the dialog refuses (an invalid field) or one that only raises the delete confirmation, which
// is cancelled in turn. That is what keeps this spec in the read lane — a compress or extract that ran
// would write into the shared tree.

const [DIALOG_A, DIALOG_B, DIALOG_C] = FIXTURE_FILES["archive-dialogs"]
const [, , , , , LOCKED, NOTE, SMALL, TREE] = FIXTURE_FILES["archive-browse"]

const OFFLINE_TITLE = "Unavailable while offline"

// Every format the dialog offers one file, in order, as its option's first line shows it.
const FORMAT_LINES = [
	"ZIP .zip",
	"7-Zip .7z",
	"Tarball, gzip .tar.gz",
	"Tarball, xz .tar.xz",
	"Tarball, Zstandard .tar.zst",
	"Tarball, uncompressed .tar",
	"Tarball, bzip2 .tar.bz2",
	"Tarball, LZ4 .tar.lz4",
	"Tarball, Brotli .tar.br",
	"Tarball, lzip .tar.lz",
	"Tarball, LZMA .tar.lzma",
	"gzip .gz",
	"bzip2 .bz2",
	"xz .xz",
	"LZMA .lzma",
	"lzip .lz",
	"LZ4 .lz4",
	"Brotli .br",
	"Zstandard .zst"
]

const SINGLE_FILE_FORMATS = 8

// The SDK's level ranges (filen-sdk-rs encode.rs, zip/write.rs, sevenz/write.rs) and the highest level
// each runs at the default 128 MiB of archive memory: LZMA-family encoders take 12 x dictionary + 1 MiB,
// PPMd 2^(L+19) + 1 MiB, Brotli fits whole. Keyed "<choice>:<method>"; null where a format has no levels.
// The defaults are the SDK's own as observed (7-Zip's Deflate and PPMd default to 5, not 6).
interface LevelOracle {
	min: number
	max: number
	defaultLevel: number
	maxAt128: number
}

const LZMA_LEVELS: LevelOracle = { min: 0, max: 9, defaultLevel: 6, maxAt128: 6 }
const SINGLE_LEVEL: LevelOracle = { min: 1, max: 1, defaultLevel: 1, maxAt128: 1 }

const LEVEL_ORACLES: Record<string, LevelOracle | null> = {
	"zip:stored": null,
	"zip:deflate": { min: 1, max: 9, defaultLevel: 6, maxAt128: 9 },
	"zip:bzip2": { min: 1, max: 9, defaultLevel: 9, maxAt128: 9 },
	"7z:lzma2": { min: 0, max: 9, defaultLevel: 5, maxAt128: 6 },
	"7z:lzma": { min: 0, max: 9, defaultLevel: 5, maxAt128: 6 },
	"7z:ppmd": { min: 1, max: 9, defaultLevel: 5, maxAt128: 7 },
	"7z:bzip2": { min: 1, max: 9, defaultLevel: 9, maxAt128: 9 },
	"7z:deflate": { min: 1, max: 9, defaultLevel: 5, maxAt128: 9 },
	"7z:copy": null,
	"tar.gz:": { min: 0, max: 9, defaultLevel: 6, maxAt128: 9 },
	"tar.xz:": LZMA_LEVELS,
	"tar.zst:": SINGLE_LEVEL,
	"tar:": null,
	"tar.bz2:": { min: 1, max: 9, defaultLevel: 9, maxAt128: 9 },
	"tar.lz4:": SINGLE_LEVEL,
	"tar.br:": { min: 0, max: 11, defaultLevel: 9, maxAt128: 11 },
	"tar.lz:": LZMA_LEVELS,
	"tar.lzma:": LZMA_LEVELS,
	"gz:": { min: 0, max: 9, defaultLevel: 6, maxAt128: 9 },
	"bz2:": { min: 1, max: 9, defaultLevel: 9, maxAt128: 9 },
	"xz:": LZMA_LEVELS,
	"lzma:": LZMA_LEVELS,
	"lz:": LZMA_LEVELS,
	"lz4:": SINGLE_LEVEL,
	"br:": { min: 0, max: 11, defaultLevel: 9, maxAt128: 11 },
	"zst:": SINGLE_LEVEL
}

const catalogueKey = (row: Pick<ArchiveCatalogueRow, "choice" | "method">): string => `${row.choice}:${row.method ?? ""}`

// The fixture root, from inside one of its scenario directories: up by the breadcrumb.
async function toFixtureRoot(page: Page): Promise<ListingHandle> {
	const { fixtureRoot } = readFixtureManifest()

	await breadcrumb(page).getByRole("link", { name: fixtureRoot, exact: true }).click()
	await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(fixtureRoot)

	return waitForListingSettled(page)
}

// The open submenu's entries, by name, in order.
async function expectMenuEntries(page: Page, names: readonly string[]): Promise<void> {
	await expect(page.getByRole("menu").last().getByRole("menuitem")).toHaveText(names)
}

// The format list's options' first lines, read with the list open; closed again after. At the default
// 128 MiB of archive memory every format runs, so none may say it needs more.
async function formatLines(page: Page, dialog: CompressDialogPO): Promise<string[]> {
	await expect(page.getByRole("listbox")).toHaveCount(0)
	await dialog.formatTrigger.focus()
	await page.keyboard.press("Enter")

	const list = page.getByRole("listbox").last()

	await expect(list.getByRole("option").first()).toBeVisible()
	await expect(list.getByText("Needs more archive memory")).toHaveCount(0)

	const lines = (await list.getByRole("option").allInnerTexts()).map(text => (text.split("\n")[0] ?? "").trim())

	await page.keyboard.press("Escape")
	await expect(page.getByRole("listbox")).toHaveCount(0)

	return lines
}

// Steps the slider from its lowest to its highest level, checking each level's memory line against
// what the hook answered for that level.
async function walkLevels(page: Page, dialog: CompressDialogPO, row: ArchiveCatalogueRow): Promise<void> {
	const { levels, maxLevel } = row

	if (levels === null || maxLevel === null) {
		throw new Error(`${catalogueKey(row)} has no levels to walk`)
	}

	expect(await dialog.range()).toEqual({ min: levels.min, max: maxLevel })
	await dialog.slider().focus()
	await page.keyboard.press("Home")

	for (let level = levels.min; level <= maxLevel; level++) {
		if (level > levels.min) {
			await page.keyboard.press("ArrowRight")
		}

		const memory = row.levelMemory[level - levels.min] ?? null

		expect(memory, `${catalogueKey(row)} level ${String(level)} memory`).not.toBeNull()
		await expect(dialog.levelLine()).toHaveText(`Level ${String(level)} · uses about ${formatBytes(memory ?? 0)} while compressing`)
	}

	await page.keyboard.press("End")
	await expect(dialog.slider()).toHaveAttribute("aria-valuenow", String(maxLevel))
}

test.describe("archive dialogs", () => {
	test("the menus offer Extract only on archives, Compress everywhere, and the selection bar follows", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-dialogs")

		// A text file: Compress, no Extract.
		await openRowMenu(page, listbox, DIALOG_A)
		await expect(page.getByRole("menuitem", { name: "Compress", exact: true })).toBeVisible()
		await expect(page.getByRole("menuitem", { name: "Extract", exact: true })).toHaveCount(0)
		await dismissOverlays(page)

		// An archive with a text file: no bulk Extract; two archives would have one (below).
		await selectRows(listbox, [DIALOG_A, DIALOG_C])
		await expect(selectionBar(page).getByRole("button", { name: "Compress", exact: true })).toBeVisible()
		await expect(selectionBar(page).getByRole("button", { name: "Extract", exact: true })).toHaveCount(0)

		// A directory: Compress, no Extract.
		const root = await toFixtureRoot(page)

		await openRowMenu(page, root.listbox, "archive-dialogs")
		await expect(page.getByRole("menuitem", { name: "Compress", exact: true })).toBeVisible()
		await expect(page.getByRole("menuitem", { name: "Extract", exact: true })).toHaveCount(0)
		await dismissOverlays(page)

		await descendInto(page, root.listbox, "archive-browse")

		const browse = await waitForListingSettled(page)

		// An archive leads with Open, then Extract; its submenu in the owner's order.
		await openRowMenu(page, browse.listbox, TREE)

		const items = page.getByRole("menu").first().getByRole("menuitem")

		await expect(items.nth(0)).toHaveAccessibleName("Open")
		await expect(items.nth(1)).toHaveAccessibleName("Extract")
		await openSubmenu(page, "Extract")
		await expectMenuEntries(page, [
			"Extract here to “e2e-arc-tree/”",
			"Extract here",
			"Extract to",
			"Choose destination…",
			"Extract with options…",
			"Browse contents"
		])
		await dismissOverlays(page)

		await openRowMenu(page, browse.listbox, TREE)
		await openSubmenu(page, "Compress")
		await expectMenuEntries(page, ["ZIP (.zip)", "7-Zip (.7z)", "Tarball (.tar.gz)", "More options…"])
		await dismissOverlays(page)

		// A single compressed file extracts as the one file it holds: no new directory.
		await openRowMenu(page, browse.listbox, NOTE)
		await openSubmenu(page, "Extract")
		await expectMenuEntries(page, [
			"Extract here as “e2e-arc-note.txt”",
			"Extract to",
			"Choose destination…",
			"Extract with options…",
			"Browse contents"
		])
		await dismissOverlays(page)

		await selectRows(browse.listbox, [TREE, SMALL, LOCKED])
		await expect(selectionBar(page).getByRole("button", { name: "Extract", exact: true })).toBeVisible()
		await expect(selectionBar(page).getByRole("button", { name: "Compress", exact: true })).toBeVisible()

		expect(cspViolations).toEqual([])
	})

	test("offline, every way into a compress or extract is disabled and says why", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")

		try {
			// The browser lists online first; its extracts then go off with the connection.
			const browser = await openArchive(page, listbox, TREE)

			await expect(browser.row("readme.txt")).toBeVisible()
			await setAppOffline(page, true)

			for (const name of ["Extract selected", "Extract all", "More places to extract to"]) {
				const button = browser.overlay.getByRole("button", { name, exact: true })

				await expect(button).toBeDisabled()
				await expect(button).toHaveAttribute("title", OFFLINE_TITLE)
			}

			await browser.close()

			await openRowMenu(page, listbox, TREE)

			for (const name of ["Compress", "Extract"]) {
				const trigger = page.getByRole("menuitem", { name, exact: true })

				await expect(trigger).toHaveAttribute("aria-disabled", "true")
				await expect(trigger).toHaveAttribute("title", OFFLINE_TITLE)
			}

			await dismissOverlays(page)
			await selectRows(listbox, [TREE, SMALL])

			for (const name of ["Compress", "Extract"]) {
				const button = selectionBar(page).getByRole("button", { name, exact: true })

				await expect(button).toBeDisabled()
				await expect(button).toHaveAttribute("title", OFFLINE_TITLE)
			}

			// The options dialog opens online and loses its submit offline.
			await setAppOffline(page, false)
			await selectRows(listbox, [TREE])

			const dialog = await openCompressDialog(page, listbox, [TREE])
			const submit = dialog.dialog.getByRole("button", { name: "Compress", exact: true })

			await expect(submit).toBeEnabled()
			await setAppOffline(page, true)
			await expect(submit).toBeDisabled()
			await expect(submit).toHaveAttribute("title", OFFLINE_TITLE)
			await dialog.cancel()
		} finally {
			await setAppOffline(page, false)
		}

		expect(cspViolations).toEqual([])
	})

	test("the compress dialog names the archive after what is selected and lists every format", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-dialogs")

		// One file: its name without the extension, every format, a single-file one keeping the full name.
		const one = await openCompressDialog(page, listbox, [DIALOG_A])

		await expect(one.nameInput).toHaveValue("dialog-a")
		await expect(one.suffix()).toHaveText(".zip")
		expect(await formatLines(page, one)).toEqual(FORMAT_LINES)
		await one.format(/^gzip \.gz/)
		await expect(one.nameInput).toHaveValue("dialog-a.txt")
		await expect(one.suffix()).toHaveText(".gz")
		await one.cancel()

		// Two files: no single-file formats, named after their directory; an edited name stays put.
		const two = await openCompressDialog(page, listbox, [DIALOG_A, DIALOG_B])

		await expect(two.nameInput).toHaveValue("archive-dialogs")
		expect(await formatLines(page, two)).toEqual(FORMAT_LINES.slice(0, FORMAT_LINES.length - SINGLE_FILE_FORMATS))
		await two.name("renamed-by-hand")
		await two.format(/^7-Zip \.7z/)
		await expect(two.nameInput).toHaveValue("renamed-by-hand")
		await expect(two.suffix()).toHaveText(".7z")
		await two.cancel()

		// A directory: its own name.
		const root = await toFixtureRoot(page)
		const directory = await openCompressDialog(page, root.listbox, ["archive-dialogs"])

		await expect(directory.nameInput).toHaveValue("archive-dialogs")
		await directory.cancel()

		expect(cspViolations).toEqual([])
	})

	test("the compress dialog's fields refuse what cannot run and keep what can", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-dialogs")
		const dialog = await openCompressDialog(page, listbox, [DIALOG_A])
		const field = dialog.dialog

		// A name no file system takes; then, with it still standing, a password left empty. The submit
		// is refused on both counts, so nothing can start.
		await dialog.name("a/b")
		await expect(field.getByText("Names can't contain \\ / : * ? \" < > | or control characters")).toBeVisible()
		await dialog.protect("", "")
		await dialog.submit()
		await expect(field.getByText("Enter a password", { exact: true })).toBeVisible()
		await expect(field).toBeVisible()

		await dialog.protect("one-password", "another-password")
		await expect(field.getByText("The passwords don't match")).toBeVisible()
		await dialog.name("dialog-a")
		await expect(field.getByText(/^Names can't contain/)).toHaveCount(0)

		// The password survives a format switch; 7-Zip hides the names by default.
		await dialog.format(/^7-Zip \.7z/)
		await expect(field.getByLabel("Password", { exact: true })).toHaveValue("one-password")
		await expect(field.getByRole("switch", { name: "Also encrypt file names", exact: true })).toHaveAttribute("aria-checked", "true")

		// Advanced: the method per family, Solid for 7-Zip but not for Copy, the AES strength for a ZIP
		// with a password.
		await dialog.advanced()
		await expect(field.getByRole("combobox", { name: "Method", exact: true })).toHaveText(/^LZMA2/)
		await expect(field.getByRole("switch", { name: "Solid archive", exact: true })).toBeVisible()
		await dialog.method("Copy (no compression)")
		await expect(field.getByRole("switch", { name: "Solid archive", exact: true })).toHaveCount(0)
		await expect(field.getByText("No compression", { exact: true })).toBeVisible()
		await dialog.method("LZMA2")
		await dialog.format(/^ZIP \.zip/)
		await expect(field.getByRole("combobox", { name: "Method", exact: true })).toHaveText(/^Deflate/)
		await expect(field.getByRole("combobox", { name: "Encryption strength", exact: true })).toHaveText(/^AES-256/)
		await expect(field.getByRole("switch", { name: "Solid archive", exact: true })).toHaveCount(0)
		await field.getByLabel("Confirm password", { exact: true }).fill("one-password")
		await expect(field.getByText("The passwords don't match")).toHaveCount(0)

		// A tarball cannot hold a password.
		await dialog.format(/^Tarball, xz \.tar\.xz/)
		await expect(dialog.protectSwitch).toBeDisabled()
		await expect(field.getByText("Only ZIP and 7-Zip archives can have a password")).toBeVisible()

		// A single compressed file's name must not read as another format (backup.tar + .gz is a tarball).
		await dialog.format(/^gzip \.gz/)
		await dialog.name("x.tar")
		await expect(field.getByText("This name reads as a different archive format. Change the name or the format.")).toBeVisible()

		await dialog.cancel()
		expect(cspViolations).toEqual([])
	})

	test("deleting the originals asks first, and the destination picker opens over the dialog", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-dialogs")
		const dialog = await openCompressDialog(page, listbox, [DIALOG_A])
		const confirm = deleteConfirm(page)

		await dialog.protect("one-password")
		await dialog.afterwards("Delete the originals permanently")
		// Valid and deleting: the submit only raises the confirmation (the job would start on its button).
		await dialog.submit()
		await expect(confirm).toContainText("downloaded again and checked")
		await expect(confirm).toContainText("The check uses the password you typed, which is why it was entered twice.")
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(confirm).toHaveCount(0)
		await expect(dialog.dialog).toBeVisible()

		await dialog.afterwards("Keep the originals")
		await dialog.dialog.getByRole("button", { name: "Change…", exact: true }).click()

		const picker = page.getByRole("dialog", { name: "Save archive in", exact: true })

		await expect(picker).toBeVisible()
		await page.keyboard.press("Escape")
		await expect(picker).toHaveCount(0)
		await expect(dialog.dialog).toBeVisible()
		await dialog.cancel()

		expect(cspViolations).toEqual([])
	})

	test("every zip and 7z method takes level 1 with the real wasm, and each level's memory shows", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const report = await page.evaluate(() => window.__filenE2E.archiveCatalogueReport())
		const byKey = new Map(report.map(row => [catalogueKey(row), row]))

		// The whole catalogue as the SDK answers it, against the table above.
		expect(report.map(catalogueKey).sort()).toEqual(Object.keys(LEVEL_ORACLES).sort())

		// One comparison over the whole catalogue, so a difference names every entry it touches.
		const observed = Object.fromEntries(
			report.map(row => [
				catalogueKey(row),
				row.levels === null
					? null
					: { min: row.levels.min, max: row.levels.max, defaultLevel: row.levels.defaultLevel, maxAt128: row.maxLevel }
			])
		)

		expect(observed).toEqual(LEVEL_ORACLES)

		for (const row of report) {
			const key = catalogueKey(row)

			expect(row.extension, key).toBe(`.${row.choice}`)

			if (row.levels === null) {
				continue
			}

			// The catalogue's own probe (level 1 for zip and 7z) and every level are ones the encoder takes.
			expect(row.probeMemory, key).not.toBeNull()
			expect(row.levelMemory, key).toHaveLength(row.levels.max - row.levels.min + 1)
			expect(
				row.levelMemory.every(memory => memory !== null && memory > 0),
				key
			).toBe(true)
		}

		const level = (key: string): ArchiveCatalogueRow => {
			const row = byKey.get(key)

			if (row === undefined) {
				throw new Error(`no catalogue row ${key}`)
			}

			return row
		}

		const { listbox } = await openFixtureRows(page, "archive-dialogs")
		const dialog = await openCompressDialog(page, listbox, [DIALOG_A])

		await dialog.advanced()

		for (const [method, key] of [
			["Deflate", "zip:deflate"],
			["BZip2", "zip:bzip2"]
		] as const) {
			await dialog.method(method)
			await walkLevels(page, dialog, level(key))
		}

		await dialog.method("Stored (no compression)")
		await expect(dialog.dialog.getByText("No compression", { exact: true })).toBeVisible()
		await expect(dialog.slider()).toHaveCount(0)

		await dialog.format(/^7-Zip \.7z/)

		for (const [method, key] of [
			["LZMA2", "7z:lzma2"],
			["LZMA", "7z:lzma"],
			["PPMd", "7z:ppmd"],
			["BZip2", "7z:bzip2"],
			["Deflate", "7z:deflate"]
		] as const) {
			await dialog.method(method)
			await walkLevels(page, dialog, level(key))
		}

		await dialog.method("Copy (no compression)")
		await expect(dialog.dialog.getByText("No compression", { exact: true })).toBeVisible()

		// A codec with a single level has nothing to slide.
		for (const format of [/^Tarball, LZ4 \.tar\.lz4/, /^Tarball, Zstandard \.tar\.zst/]) {
			const slider = dialog.dialog.getByRole("slider", { includeHidden: true })

			await dialog.format(format)
			// Its track has no width at all, so the thumb's input is only in the tree as a hidden element.
			await expect(slider).toBeDisabled()
			await expect(slider).toHaveAttribute("aria-valuenow", "1")
			await expect(dialog.levelLine()).toHaveText(/^Level 1 · /)
		}

		await dialog.cancel()
		expect(cspViolations).toEqual([])
	})

	test("the archive memory setting moves the highest level each format runs", async ({ page }) => {
		const cspViolations = trackCspViolations(page)
		const openDialog = async (): Promise<CompressDialogPO> => {
			await bootTo(page)

			const { listbox } = await openFixtureRows(page, "archive-dialogs")

			return openCompressDialog(page, listbox, [DIALOG_A])
		}

		await bootTo(page)

		// 64 MiB: LZMA-family encoders top out at level 4.
		await setArchiveMemory(page, 64)

		let dialog = await openDialog()

		await dialog.format(/^7-Zip \.7z/)
		expect((await dialog.range()).max).toBe(4)
		await expect(
			dialog.dialog.getByText(
				`Levels 5–9 need more than the ${formatBytes(64 * 1024 * 1024)} of archive memory set in Advanced settings`
			)
		).toBeVisible()
		await dialog.format(/^Tarball, xz \.tar\.xz/)
		expect((await dialog.range()).max).toBe(4)
		await dialog.cancel()

		// 512 MiB: LZMA2 runs to 8, PPMd to its top.
		await setArchiveMemory(page, 512, 64)
		dialog = await openDialog()
		await dialog.format(/^7-Zip \.7z/)
		expect((await dialog.range()).max).toBe(8)
		await dialog.advanced()
		await dialog.method("PPMd")
		expect((await dialog.range()).max).toBe(9)
		await dialog.cancel()

		expect(cspViolations).toEqual([])
	})

	test("the extract dialog offers the archive's own places and options", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const dialog = await openExtractDialog(page, listbox, TREE)
		const field = dialog.dialog
		const confirm = deleteConfirm(page)

		// Beside the archive by default, into a new directory named after it.
		await expect(field.getByRole("group", { name: "Extract to", exact: true })).toHaveText("archive-browse")
		await expect(field.getByRole("radio", { name: "Into a new directory", exact: true })).toBeChecked()
		await expect(dialog.folderNameInput).toHaveValue("e2e-arc-tree")
		await expect(field.getByRole("radio", { name: "Directly into archive-browse", exact: true })).toBeVisible()
		await expect(field.getByRole("radio", { name: "Keep the archive", exact: true })).toBeChecked()
		await expect(field.getByRole("radio", { name: "Move the archive to the trash", exact: true })).toBeVisible()
		await expect(field.getByRole("switch", { name: "Skip macOS metadata", exact: true })).toHaveAttribute("aria-checked", "true")

		await dialog.password("")
		await expect(field.getByLabel("Password", { exact: true })).toBeVisible()

		// Deleting the archive asks first, and says the macOS metadata left out goes with it.
		await dialog.afterwards("Delete the archive permanently")
		await dialog.submit()
		await expect(confirm).toContainText(
			"Once everything is extracted and checked, the archive is deleted permanently. It will not be in the trash. macOS metadata left out goes with it."
		)
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(confirm).toHaveCount(0)

		await dialog.skipMac(false)
		await dialog.submit()
		await expect(confirm).toBeVisible()
		await expect(confirm).not.toContainText("macOS metadata")
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(confirm).toHaveCount(0)
		await dialog.cancel()

		// A single compressed file says what it becomes.
		const single = await openExtractDialog(page, listbox, NOTE)

		await expect(
			single.dialog.getByText("If this is a single compressed file, it extracts as “e2e-arc-note.txt” straight into the destination.")
		).toBeVisible()
		await single.cancel()

		expect(cspViolations).toEqual([])
	})
})
