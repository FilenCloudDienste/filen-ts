import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import {
	clickSidebarLink,
	LAZY_VIEWER_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS,
	reloadToShell,
	setTallListingViewport,
	uploadFiles,
	waitForListingSettled
} from "./listing"
import { gotoSettings, openSettingsSection } from "./settings"

// Page objects for compress, extract and the archive browser: the drive menus that start them, their
// dialogs, the browser in the preview overlay, the archive memory setting. Every lookup by item name
// is anchored (namePattern), every submenu opened by its exact name.

// A name as a whole token of an accessible name: a drive row's or an archive row's name is followed by
// its size and date columns (and preceded, in grid view, by a badge), so `exact` never matches one and
// a bare substring matches every sibling whose name starts with it. Never right after a comma, where a
// Modified date's year ("Jan 1, 2024") would pass for a name.
export function namePattern(name: string): RegExp {
	return new RegExp(`(^|(?<!,)\\s)${escapeRegExp(name)}(\\s|$)`)
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A name at the start of an accessible name: an archive row's (or a list-view drive row's) name leads,
// so its size and date columns can never match a name such as "2024" the way a token match does.
export function leadingNamePattern(name: string): RegExp {
	return new RegExp(`^${escapeRegExp(name)}(\\s|$)`)
}

// A drive row by its whole leading name. A token match takes a name such as "2024" for a row whose date
// column reads "Jan 1, 2024", and "x" for its keep-both sibling "x (1)"; this does neither.
export function itemRow(listbox: Locator, name: string): Locator {
	return listbox.getByRole("option", {
		name: new RegExp(`^${escapeRegExp(name)}(?!\\s\\(\\d+\\))(\\s|$)`)
	})
}

// Exactly these drive rows, each waited for as long as a write takes to show.
export async function expectEntries(listbox: Locator, names: readonly string[]): Promise<void> {
	for (const name of names) {
		await expect(itemRow(listbox, name)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	}

	await expect(listbox.getByRole("option")).toHaveCount(names.length)
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
// null, closes it again). The picker opens on the current destination, which may be anywhere, so it is
// walked back to the root first.
export async function pickDestination(
	page: Page,
	dialogName: PickerTitle,
	path: readonly string[],
	confirm: "Extract here" | "Save here" | "Copy here" | null
): Promise<void> {
	const dialog = page.getByRole("dialog", { name: dialogName, exact: true })
	const root = dialog.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name: "Cloud Drive", exact: true })

	await expect(dialog).toBeVisible()

	if (await root.isEnabled()) {
		await root.click()
	}

	await expect(root).toBeDisabled()

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
	// The destination's name, beside "Change…".
	saveIn: Locator
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

// The compress form wherever it opens: "More options…" on drive rows or Photos tiles, or a public
// directory link's "Save as archive".
export function compressDialog(page: Page, title: "Compress" | "Save as archive" = "Compress"): CompressDialogPO {
	const dialog = page.getByRole("dialog", { name: title, exact: true })
	const nameInput = dialog.getByLabel("Name", { exact: true })
	const formatTrigger = dialog.getByRole("combobox", { name: "Format", exact: true })
	const slider = (): Locator => dialog.getByRole("slider")
	const protectSwitch = dialog.getByRole("switch", { name: "Protect with a password", exact: true })

	return {
		dialog,
		nameInput,
		saveIn: dialog.getByRole("group", { name: "Save in", exact: true }),
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
		range: async () => ({ min: Number(await slider().getAttribute("min")), max: Number(await slider().getAttribute("max")) }),
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

	return waitForCompressDialog(page, title)
}

// The form once it shows its name (it loads the format catalogue first).
export async function waitForCompressDialog(page: Page, title: "Compress" | "Save as archive" = "Compress"): Promise<CompressDialogPO> {
	const dialog = compressDialog(page, title)

	await expect(dialog.nameInput).toBeVisible({ timeout: 30_000 })

	return dialog
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
	await openExtractSubmenu(page, listbox, name)

	const item = page.getByRole("menuitem", { name: entry })

	await expect(item).toBeEnabled()
	await item.click()
}

export async function openExtractSubmenu(page: Page, listbox: Locator, name: string): Promise<void> {
	await openRowMenu(page, listbox, name)
	await openSubmenu(page, "Extract")
}

// A row's Extract ▸ Extract to ▸ … ▸ Extract here. The last directory of `path` must be empty.
export async function extractToTree(page: Page, listbox: Locator, name: string, path: readonly string[]): Promise<void> {
	await openExtractSubmenu(page, listbox, name)
	await pickTreeTarget(page, "Extract to", path, "Extract here")
}

// A row's Extract ▸ Choose destination… through the picker.
export async function extractToPicker(page: Page, listbox: Locator, name: string, path: readonly string[]): Promise<void> {
	await openExtractSubmenu(page, listbox, name)
	await page.getByRole("menuitem", { name: "Choose destination…", exact: true }).click()
	await pickDestination(page, "Extract to", path, "Extract here")
}

// The directory an extract into a new directory makes: the archive's name without its extension.
export function archiveStem(archive: string): string {
	return archive.replace(/\.(zip|7z|tar|tar\.gz)$/, "")
}

function archiveMimeType(name: string): string {
	return name.endsWith(".zip") ? "application/zip" : name.endsWith(".gz") ? "application/gzip" : "application/octet-stream"
}

// Uploads generated archives into the directory shown and waits for each row.
export async function uploadArchives(page: Page, listbox: Locator, files: readonly { name: string; buffer: Buffer }[]): Promise<void> {
	await uploadFiles(
		page,
		files.map(({ name, buffer }) => ({
			name,
			mimeType: archiveMimeType(name),
			buffer
		}))
	)

	for (const { name } of files) {
		await expect(itemRow(listbox, name)).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	}
}

// Opens a text file's preview, checks its text and closes it again.
export async function expectTextPreview(page: Page, listbox: Locator, name: string, text: string): Promise<void> {
	const overlay = previewOverlay(page)

	await itemRow(listbox, name).dblclick()
	await expect(overlay.locator(".cm-content")).toContainText(text.trimEnd(), { timeout: LAZY_VIEWER_TIMEOUT_MS })
	await overlay.getByRole("button", { name: "Close", exact: true }).click()
	await expect(overlay).toHaveCount(0)
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
	// Ticks the row's checkbox unless it is ticked already.
	ensureChecked: (name: string) => Promise<void>
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
		ensureChecked: async name => {
			const target = row(name)

			if ((await target.getAttribute("aria-selected")) !== "true") {
				await target.locator('span[aria-hidden="true"]').first().click()
			}

			await expect(target).toHaveAttribute("aria-selected", "true")
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

// Opens the trash. A run leaves its trashed debris there for hours (the sweep takes only what is
// older), and directories list before files, so a file just trashed can sit past the rows even a tall
// viewport renders: find one with revealRow.
export async function openTrash(page: Page): Promise<Locator> {
	await setTallListingViewport(page)
	await clickSidebarLink(page, "Trash", /\/trash$/)

	const { listbox } = await waitForListingSettled(page)

	return listbox
}

// Scrolls the listing's own scroller a screen at a time from the top until `row` renders: the listing
// virtualizes its rows, so one far down is not in the DOM until scrolled to.
export async function revealRow(listbox: Locator, row: Locator, timeout = 30_000): Promise<void> {
	const scroll = (top: boolean): Promise<boolean> =>
		listbox.evaluate((element, toTop) => {
			let scroller: HTMLElement | null = element as HTMLElement

			while (
				scroller !== null &&
				!(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))
			) {
				scroller = scroller.parentElement
			}

			if (scroller === null) {
				return false
			}

			const before = scroller.scrollTop

			scroller.scrollTop = toTop ? 0 : before + scroller.clientHeight

			return scroller.scrollTop !== before
		}, top)

	await expect(async () => {
		await scroll(true)

		for (let step = 0; step < 64 && (await row.count()) === 0; step++) {
			if (!(await scroll(false))) {
				break
			}
		}

		await expect(row).toBeVisible({ timeout: 1_000 })
	}).toPass({ timeout })
}

// The trash lists every one of `names`.
export async function expectInTrash(page: Page, names: readonly string[]): Promise<void> {
	const listbox = await openTrash(page)

	for (const name of names) {
		await revealRow(listbox, rowOf(listbox, name))
	}
}
