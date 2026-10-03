import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import { clickSidebarLink, reloadToShell, setTallListingViewport, waitForListingSettled } from "./listing"
import { gotoSettings, openSettingsSection } from "./settings"

// Page objects for compress, extract and the archive browser: the drive menus that start them, their
// dialogs, the browser in the preview overlay, the archive memory setting. Every lookup by item name
// is anchored (namePattern), every submenu opened by its exact name.

// A name as a whole token of an accessible name: a drive row's or an archive row's name is followed by
// its size and date columns (and preceded, in grid view, by a badge), so `exact` never matches one and
// a bare substring matches every sibling whose name starts with it.
export function namePattern(name: string): RegExp {
	return new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|$)`)
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A name at the start of an accessible name: an archive row's (or a list-view drive row's) name leads,
// so its size and date columns can never match a name such as "2024" the way a token match does.
export function leadingNamePattern(name: string): RegExp {
	return new RegExp(`^${escapeRegExp(name)}(\\s|$)`)
}

function entryOf(list: Locator, name: string): Locator {
	return list.getByRole("option", { name: leadingNamePattern(name) })
}

function rowOf(listbox: Locator, name: string): Locator {
	return listbox.getByRole("option", { name: namePattern(name) })
}

// Sets a switch to `on`, whichever state it is in.
async function setSwitch(control: Locator, on: boolean): Promise<void> {
	if ((await control.getAttribute("aria-checked")) !== String(on)) {
		await control.click()
	}

	await expect(control).toHaveAttribute("aria-checked", String(on))
}

// Picks an option of a Base UI Select. Opened from the keyboard, not a click: Base UI opens the list
// with the selected item under the pointer and lets a late mouse release commit it (settings.spec.ts).
// An option's accessible name includes its hint line, hence the pattern.
export async function pickSelectOption(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
	await expect(page.getByRole("listbox")).toHaveCount(0)
	await trigger.focus()
	await page.keyboard.press("Enter")

	const list = page.getByRole("listbox").last()

	await expect(list).toBeVisible()
	await list.getByRole("option", typeof option === "string" ? { name: option, exact: true } : { name: option }).click()
	await expect(page.getByRole("listbox")).toHaveCount(0)
}

// ── Menus ───────────────────────────────────────────────────────────────────────────────────────────

// Opens a drive row's "More actions" menu.
export async function openRowMenu(page: Page, listbox: Locator, name: string): Promise<void> {
	await rowOf(listbox, name).getByRole("button", { name: "More actions", exact: true }).click()
	await expect(page.getByRole("menu").first()).toBeVisible()
}

// Opens a submenu from its trigger; the tree levels are submenus of submenus, the newest last.
export async function openSubmenu(page: Page, name: string): Promise<void> {
	await page.getByRole("menuitem", { name, exact: true }).last().click()
}

// Walks a directory tree submenu ("Copy" or "Extract to") down `path` from the drive root and runs
// its action there. The target must have no subdirectories: the action is taken from the level that
// says "No directories", which a bare .last() could resolve on the parent level before it mounts.
export async function pickTreeTarget(
	page: Page,
	trigger: "Copy" | "Extract to",
	path: readonly string[],
	action: "Copy here" | "Extract here"
): Promise<void> {
	await openSubmenu(page, trigger)

	for (const directory of path) {
		await openSubmenu(page, directory)
	}

	await page
		.getByRole("menu")
		.filter({ has: page.getByRole("menuitem", { name: "No directories", exact: true }) })
		.getByRole("menuitem", { name: action, exact: true })
		.click()
}

export type PickerTitle = "Extract to" | "Save archive in" | "Copy to"

// Drives the destination picker from the drive root down `path`, then confirms (or, with `confirm`
// null, closes it again).
export async function pickDestination(
	page: Page,
	dialogName: PickerTitle,
	path: readonly string[],
	confirm: "Extract here" | "Save here" | "Copy here" | null
): Promise<void> {
	const dialog = page.getByRole("dialog", { name: dialogName, exact: true })

	await expect(dialog).toBeVisible()

	for (const directory of path) {
		await dialog.getByRole("button", { name: namePattern(directory) }).dblclick()
		await expect(dialog.getByRole("navigation", { name: "Breadcrumb" }).getByText(directory, { exact: true })).toBeVisible()
	}

	if (confirm === null) {
		await page.keyboard.press("Escape")
	} else {
		await dialog.getByRole("button", { name: confirm, exact: true }).click()
	}

	await expect(dialog).toHaveCount(0)
}

// Selects `names` in the listing: the first by a click, the rest added with the mod key.
export async function selectRows(listbox: Locator, names: readonly string[]): Promise<void> {
	// From nothing selected: a click on the one row already selected alone would clear it instead.
	const clear = listbox.page().getByRole("button", { name: "Clear selection", exact: true })

	if ((await clear.count()) > 0) {
		await clear.click()
		await expect(clear).toHaveCount(0)
	}

	for (const [index, name] of names.entries()) {
		const row = rowOf(listbox, name)

		await row.click(index === 0 ? {} : { modifiers: ["ControlOrMeta"] })
		await expect(row).toHaveAttribute("aria-selected", "true")
	}
}

export function selectionBar(page: Page): Locator {
	return page.getByRole("toolbar", { name: "Selection actions" })
}

// The Compress or Extract entries for `names`: one row's submenu, or the selection bar's menu for several.
async function openArchiveEntries(page: Page, listbox: Locator, names: readonly string[], action: "Compress" | "Extract"): Promise<void> {
	const [only] = names

	if (names.length === 1 && only !== undefined) {
		await openRowMenu(page, listbox, only)
		await openSubmenu(page, action)

		return
	}

	await selectRows(listbox, names)
	await selectionBar(page).getByRole("button", { name: action, exact: true }).click()
	await expect(page.getByRole("menu").first()).toBeVisible()
}

// ── Compress ────────────────────────────────────────────────────────────────────────────────────────

export type CompressPreset = "ZIP (.zip)" | "7-Zip (.7z)" | "Tarball (.tar.gz)"

// Starts a preset compress of `names` (the format's last-used options, never a password or a disposal).
export async function compressPreset(page: Page, listbox: Locator, names: readonly string[], preset: CompressPreset): Promise<void> {
	await openArchiveEntries(page, listbox, names, "Compress")
	await page.getByRole("menuitem", { name: preset, exact: true }).click()
}

export type CompressAfterwards = "Keep the originals" | "Move the originals to the trash" | "Delete the originals permanently"

export interface CompressDialogPO {
	dialog: Locator
	nameInput: Locator
	name: (value: string) => Promise<void>
	// The extension shown after the name.
	suffix: () => Locator
	formatTrigger: Locator
	// Picks a format by its option's name ("ZIP …", "Tarball, xz …"); anchor the pattern.
	format: (option: RegExp) => Promise<void>
	slider: () => Locator
	// Sets the level from the keyboard: Home, then ArrowRight up to `level`.
	level: (level: number) => Promise<void>
	range: () => Promise<{ min: number; max: number }>
	// "Level N · uses about … while compressing".
	levelLine: () => Locator
	protectSwitch: Locator
	protect: (password: string, confirm?: string) => Promise<void>
	encryptNames: (on: boolean) => Promise<void>
	advanced: () => Promise<void>
	method: (label: string) => Promise<void>
	solid: (on: boolean) => Promise<void>
	aes: (label: "AES-128" | "AES-192" | "AES-256") => Promise<void>
	afterwards: (label: CompressAfterwards) => Promise<void>
	changeDestination: (path: readonly string[]) => Promise<void>
	submit: () => Promise<void>
	confirmDelete: () => Promise<void>
	cancel: () => Promise<void>
}

// The "Delete permanently?" confirmation a removing job asks first.
export function deleteConfirm(page: Page): Locator {
	return page.getByRole("alertdialog", { name: "Delete permanently?", exact: true })
}

function compressDialogPO(page: Page, dialog: Locator): CompressDialogPO {
	const nameInput = dialog.getByLabel("Name", { exact: true })
	const formatTrigger = dialog.getByRole("combobox", { name: "Format", exact: true })
	const slider = (): Locator => dialog.getByRole("slider")
	const protectSwitch = dialog.getByRole("switch", { name: "Protect with a password", exact: true })

	return {
		dialog,
		nameInput,
		name: async value => {
			await nameInput.fill(value)
		},
		suffix: () => nameInput.locator("xpath=following-sibling::span[1]"),
		formatTrigger,
		format: async option => {
			await pickSelectOption(page, formatTrigger, option)
		},
		slider,
		level: async level => {
			const control = slider()
			const min = Number(await control.getAttribute("min"))

			await control.focus()
			await page.keyboard.press("Home")

			for (let current = min; current < level; current++) {
				await page.keyboard.press("ArrowRight")
			}

			await expect(control).toHaveAttribute("aria-valuenow", String(level))
		},
		// Base UI's thumb is a native range input: its bounds are min/max, not aria-value*.
		range: async () => ({
			min: Number(await slider().getAttribute("min")),
			max: Number(await slider().getAttribute("max"))
		}),
		levelLine: () => dialog.getByText(/^Level \d+ · uses about .+ while compressing$/),
		protectSwitch,
		protect: async (password, confirm = password) => {
			await setSwitch(protectSwitch, true)
			await dialog.getByLabel("Password", { exact: true }).fill(password)
			await dialog.getByLabel("Confirm password", { exact: true }).fill(confirm)
		},
		encryptNames: async on => {
			await setSwitch(dialog.getByRole("switch", { name: "Also encrypt file names", exact: true }), on)
		},
		advanced: async () => {
			const toggle = dialog.getByRole("button", { name: "Advanced", exact: true })

			if ((await toggle.getAttribute("aria-expanded")) !== "true") {
				await toggle.click()
			}

			await expect(dialog.getByRole("combobox", { name: "Method", exact: true })).toBeVisible()
		},
		method: async label => {
			await pickSelectOption(page, dialog.getByRole("combobox", { name: "Method", exact: true }), label)
		},
		solid: async on => {
			await setSwitch(dialog.getByRole("switch", { name: "Solid archive", exact: true }), on)
		},
		aes: async label => {
			await pickSelectOption(page, dialog.getByRole("combobox", { name: "Encryption strength", exact: true }), label)
		},
		afterwards: async label => {
			const radio = dialog.getByRole("radio", { name: label, exact: true })

			await radio.click()
			await expect(radio).toBeChecked()
		},
		changeDestination: async path => {
			await dialog.getByRole("button", { name: "Change…", exact: true }).click()
			await pickDestination(page, "Save archive in", path, "Save here")
		},
		submit: async () => {
			await dialog.getByRole("button", { name: "Compress", exact: true }).click()
		},
		confirmDelete: async () => {
			const confirm = deleteConfirm(page)

			await expect(confirm).toBeVisible()
			await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click()
			await expect(confirm).toHaveCount(0)
		},
		cancel: async () => {
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
			await expect(dialog).toHaveCount(0)
		}
	}
}

// Opens "More options…" on `names` and waits for the form (it loads the format catalogue first).
export async function openCompressDialog(
	page: Page,
	listbox: Locator,
	names: readonly string[],
	title: "Compress" | "Save as archive" = "Compress"
): Promise<CompressDialogPO> {
	await openArchiveEntries(page, listbox, names, "Compress")
	await page.getByRole("menuitem", { name: "More options…", exact: true }).click()

	const dialog = page.getByRole("dialog", { name: title, exact: true })

	await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible({ timeout: 30_000 })

	return compressDialogPO(page, dialog)
}

// ── Extract ─────────────────────────────────────────────────────────────────────────────────────────

export type ExtractAfterwards = "Keep the archive" | "Move the archive to the trash" | "Delete the archive permanently"

export interface ExtractDialogPO {
	dialog: Locator
	changeDestination: (path: readonly string[]) => Promise<void>
	root: (choice: "Into a new directory" | RegExp) => Promise<void>
	folderNameInput: Locator
	folderName: (value: string) => Promise<void>
	// Opens "This archive has a password" and types it.
	password: (value: string) => Promise<void>
	skipMac: (on: boolean) => Promise<void>
	afterwards: (label: ExtractAfterwards) => Promise<void>
	submit: () => Promise<void>
	confirmDelete: () => Promise<void>
	cancel: () => Promise<void>
}

// Opens "Extract with options…" on one archive row and waits for the form (it asks the name's format).
export async function openExtractDialog(page: Page, listbox: Locator, name: string): Promise<ExtractDialogPO> {
	await openRowMenu(page, listbox, name)
	await openSubmenu(page, "Extract")
	await page.getByRole("menuitem", { name: "Extract with options…", exact: true }).click()

	const dialog = page.getByRole("dialog", { name: "Extract", exact: true })
	const folderNameInput = dialog.getByLabel("Directory name", { exact: true })

	await expect(folderNameInput).toBeVisible({ timeout: 30_000 })

	return {
		dialog,
		changeDestination: async path => {
			await dialog.getByRole("button", { name: "Change…", exact: true }).click()
			await pickDestination(page, "Extract to", path, "Extract here")
		},
		root: async choice => {
			const radio = dialog.getByRole("radio", typeof choice === "string" ? { name: choice, exact: true } : { name: choice })

			await radio.click()
			await expect(radio).toBeChecked()
		},
		folderNameInput,
		folderName: async value => {
			await folderNameInput.fill(value)
		},
		password: async value => {
			const toggle = dialog.getByRole("button", { name: "This archive has a password", exact: true })

			if ((await toggle.getAttribute("aria-expanded")) !== "true") {
				await toggle.click()
			}

			await dialog.getByLabel("Password", { exact: true }).fill(value)
		},
		skipMac: async on => {
			await setSwitch(dialog.getByRole("switch", { name: "Skip macOS metadata", exact: true }), on)
		},
		afterwards: async label => {
			const radio = dialog.getByRole("radio", { name: label, exact: true })

			await radio.click()
			await expect(radio).toBeChecked()
		},
		submit: async () => {
			await dialog.getByRole("button", { name: "Extract", exact: true }).click()
		},
		confirmDelete: async () => {
			const confirm = deleteConfirm(page)

			await expect(confirm).toBeVisible()
			await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click()
			await expect(confirm).toHaveCount(0)
		},
		cancel: async () => {
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
			await expect(dialog).toHaveCount(0)
		}
	}
}

// One of the quick entries of a row's Extract submenu: `Extract here to “…/”`, "Extract here",
// `Extract here as “…”`. The labels wait on the archive name's answer, so the entry is matched by
// pattern and clicked once enabled.
export async function extractQuick(page: Page, listbox: Locator, name: string, entry: RegExp): Promise<void> {
	await openRowMenu(page, listbox, name)
	await openSubmenu(page, "Extract")

	const item = page.getByRole("menuitem", { name: entry })

	await expect(item).toBeEnabled()
	await item.click()
}

// ── Archive browser ─────────────────────────────────────────────────────────────────────────────────

// Where the browser's "Extract selected" / "Extract all" go.
export type BrowserExtractTarget =
	{ besideNewFolder: true } | { beside: true } | { tree: readonly string[] } | { picker: readonly string[] }

export interface ArchiveBrowserPO {
	// The preview overlay holding the browser.
	overlay: Locator
	// The listbox of the directory shown ("Contents of <name>").
	list: Locator
	row: (name: string) => Locator
	// Clicks a row's checkbox (a decorative span the listbox draws; a click on it toggles).
	check: (row: Locator) => Promise<void>
	selectAll: () => Promise<void>
	// Double-clicks a directory row and waits for its crumb.
	into: (directory: string) => Promise<void>
	crumbs: Locator
	search: (query: string) => Promise<void>
	sort: (column: "Name" | "Size" | "Modified") => Promise<void>
	sortButton: (column: "Name" | "Size" | "Modified") => Locator
	footerSummary: () => Locator
	extractSelected: (target: BrowserExtractTarget) => Promise<void>
	extractAll: (target: BrowserExtractTarget) => Promise<void>
	// The gate a big tarball or single compressed file shows before it is listed.
	gate: { body: Locator; browse: Locator; extractAll: Locator }
	// Text in the browser's status banners (stopped, failed, encrypted, duplicates, reading…).
	status: (text: string | RegExp) => Locator
	// Answers the "Archive password" prompt.
	unlock: (password: string) => Promise<void>
	close: () => Promise<void>
}

// The preview overlay: the one dialog with the pager's "Next file".
export function previewOverlay(page: Page): Locator {
	return page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Next file", exact: true }) })
}

export function archivePasswordPrompt(page: Page): Locator {
	return page.getByRole("dialog", { name: "Archive password", exact: true })
}

async function pickBrowserTarget(page: Page, target: BrowserExtractTarget): Promise<void> {
	const menu = page.getByRole("menu").last()

	await expect(menu).toBeVisible()

	if ("besideNewFolder" in target) {
		await menu.getByRole("menuitem", { name: /^Extract to “.+\/” next to the archive$/ }).click()
	} else if ("beside" in target) {
		await menu.getByRole("menuitem", { name: "Extract next to the archive", exact: true }).click()
	} else if ("tree" in target) {
		await pickTreeTarget(page, "Extract to", target.tree, "Extract here")
	} else {
		await menu.getByRole("menuitem", { name: "Choose destination…", exact: true }).click()
		await pickDestination(page, "Extract to", target.picker, "Extract here")
	}
}

export function archiveBrowser(page: Page): ArchiveBrowserPO {
	const overlay = previewOverlay(page)
	const list = overlay.getByRole("listbox", { name: /^Contents of / })
	const crumbs = overlay.getByRole("navigation", { name: "Location in the archive", exact: true })
	const row = (name: string): Locator => entryOf(list, name)
	const sortButton = (column: "Name" | "Size" | "Modified"): Locator => overlay.getByRole("button", { name: column, exact: true })
	const extractAllButton = overlay.getByRole("button", { name: "Extract all", exact: true })

	return {
		overlay,
		list,
		row,
		check: async target => {
			await target.locator('span[aria-hidden="true"]').first().click()
		},
		selectAll: async () => {
			await overlay.getByRole("checkbox", { name: "Select all", exact: true }).click()
		},
		into: async directory => {
			const target = row(directory)

			// A skipped directory (__MACOSX) is aria-disabled for selection yet still opens.
			await target.dblclick({ force: (await target.getAttribute("aria-disabled")) === "true" })
			await expect(crumbs.getByRole("button", { name: directory, exact: true })).toHaveAttribute("aria-current", "location")
		},
		crumbs,
		search: async query => {
			await overlay.getByRole("searchbox", { name: "Search this directory", exact: true }).fill(query)
		},
		sort: async column => {
			await sortButton(column).click()
		},
		sortButton,
		footerSummary: () => overlay.locator('span[aria-live="polite"]'),
		extractSelected: async target => {
			await overlay.getByRole("button", { name: "Extract selected", exact: true }).click()
			await pickBrowserTarget(page, target)
		},
		extractAll: async target => {
			const more = overlay.getByRole("button", { name: "More places to extract to", exact: true })

			if ("besideNewFolder" in target && (await more.count()) > 0) {
				await extractAllButton.click()

				return
			}

			await ((await more.count()) > 0 ? more : extractAllButton).click()
			await pickBrowserTarget(page, target)
		},
		gate: {
			body: overlay.getByText(/^Listing its contents reads the whole .+ archive\.$/),
			browse: overlay.getByRole("button", { name: "Browse contents", exact: true }),
			extractAll: extractAllButton
		},
		status: text => overlay.getByText(text),
		unlock: async password => {
			const prompt = archivePasswordPrompt(page)

			await expect(prompt).toBeVisible()
			await prompt.getByLabel("Password", { exact: true }).fill(password)
			await prompt.getByRole("button", { name: "Unlock", exact: true }).click()
			await expect(prompt).toHaveCount(0)
		},
		close: async () => {
			await overlay.getByRole("button", { name: "Close", exact: true }).click()
			await expect(overlay).toHaveCount(0)
		}
	}
}

// Opens an archive row in the browser: a double-click, the row menu's Open, or its Extract ▸ Browse
// contents. Returns once the overlay is up; what it shows (rows, gate, prompt) is the caller's to wait for.
export async function openArchive(
	page: Page,
	listbox: Locator,
	name: string,
	via: "dblclick" | "open" | "browse" = "dblclick"
): Promise<ArchiveBrowserPO> {
	if (via === "dblclick") {
		await rowOf(listbox, name).dblclick()
	} else {
		await openRowMenu(page, listbox, name)

		if (via === "open") {
			await page.getByRole("menuitem", { name: "Open", exact: true }).click()
		} else {
			await openSubmenu(page, "Extract")
			await page.getByRole("menuitem", { name: "Browse contents", exact: true }).click()
		}
	}

	const browser = archiveBrowser(page)

	await expect(browser.overlay).toBeVisible({ timeout: 30_000 })

	return browser
}

// Exactly these rows, in any order (an archive list, or a drive listing in list view).
export async function expectRows(listbox: Locator, names: readonly string[]): Promise<void> {
	for (const name of names) {
		await expect(entryOf(listbox, name)).toBeVisible()
	}

	await expect(listbox.getByRole("option")).toHaveCount(names.length)
}

// A row showing `size` (as formatBytes renders it) in its size column.
export async function expectRowSize(listbox: Locator, name: string, size: string): Promise<void> {
	await expect(entryOf(listbox, name)).toHaveAccessibleName(new RegExp(`^${escapeRegExp(name)}\\s.*${escapeRegExp(size)}(\\s|$)`))
}

// Sets Advanced ▸ Archive memory and reloads, so the budget is in effect. The row names the budget
// still in effect until then (`inEffectMib`, the one this page loaded with).
export async function setArchiveMemory(page: Page, mib: 64 | 128 | 256 | 512, inEffectMib = 128): Promise<void> {
	await gotoSettings(page)
	await openSettingsSection(page, "Advanced")
	await pickSelectOption(page, page.getByRole("combobox", { name: "Archive memory", exact: true }), new RegExp(`^${String(mib)} MiB`))

	if (mib !== inEffectMib) {
		await expect(page.getByText(`In effect now: ${String(inEffectMib)} MiB.`)).toBeVisible()
	}

	await reloadToShell(page)
}

// The trash lists every one of `names`.
export async function expectInTrash(page: Page, names: readonly string[]): Promise<void> {
	await setTallListingViewport(page)
	await clickSidebarLink(page, "Trash", /\/trash$/)

	const { listbox } = await waitForListingSettled(page)

	for (const name of names) {
		await expect(rowOf(listbox, name)).toBeVisible({ timeout: 30_000 })
	}
}
