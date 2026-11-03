import type { DesktopSyncNotice, DesktopSyncResolution, DesktopSyncReviewFinding } from "@filen/shared/desktop"
import type { Locator, Page } from "playwright-core"
import { sync as SYNC_TEXT } from "../../../../filen-web/src/locales/en/sync.ts"
import { fail, waitFor } from "../support.ts"

// The 4.x sync pages (filen-web features/sync) driven as a user does: the rail's Computer group, the pair in the sync
// sidebar, its review card, its notices and its Issues tab (conflicts one by one or all at once, held deletions). Every
// label is the web app's own English catalog (locales/en/sync.ts), so a copy change there reaches the harness too. The
// master-key reminder that may cover any step is the caller's (app.ts underReminder).

type SyncKey = keyof typeof SYNC_TEXT

// A catalog string with its {{name}} values filled in.
export function syncText(key: SyncKey, values: Readonly<Record<string, string | number>> = {}): string {
	return SYNC_TEXT[key].replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
		const value = values[name]

		return value === undefined ? whole : String(value)
	})
}

// A counted catalog string (`<base>_one` / `<base>_other`, English plurals) with {{count}} filled in.
export function syncCount(base: string, count: number): string {
	const key = `${base}_${count === 1 ? "one" : "other"}`

	if (!(key in SYNC_TEXT)) {
		fail(`the sync catalog has no ${key}`)
	}

	return syncText(key as SyncKey, { count })
}

const ROW_LABEL: Record<DesktopSyncResolution, SyncKey> = {
	keepLocal: "conflictKeepLocal",
	keepRemote: "conflictKeepRemote",
	keepBoth: "conflictKeepBoth"
}
const BULK: Record<DesktopSyncResolution, { label: SyncKey; body: string; kept: string }> = {
	keepLocal: { label: "conflictsKeepAllLocal", body: "conflictsKeepAllLocalBody", kept: "conflictsKeptAllLocal" },
	keepRemote: { label: "conflictsKeepAllRemote", body: "conflictsKeepAllRemoteBody", kept: "conflictsKeptAllRemote" },
	keepBoth: { label: "conflictsKeepAllBoth", body: "conflictsKeepAllBothBody", kept: "conflictsKeptAllBoth" }
}
const KEPT: Record<DesktopSyncResolution, SyncKey> = {
	keepLocal: "conflictKeptLocal",
	keepRemote: "conflictKeptRemote",
	keepBoth: "conflictKeptBoth"
}
// The text before the bin path in a Keep the cloud's toast that moved this device's copy aside.
const BINNED_PREFIX = SYNC_TEXT.conflictKeptRemoteBinned.split("{{path}}")[0] ?? ""

// Where a Keep the cloud's toast says this device's copy went; null for a toast that names no bin path.
export function binPathFromToast(text: string): string | null {
	const trimmed = text.trim()

	return BINNED_PREFIX !== "" && trimmed.startsWith(BINNED_PREFIX) ? trimmed.slice(BINNED_PREFIX.length).trim() || null : null
}

// A settings group of the Issues tab by its title.
function group(page: Page, title: SyncKey): Locator {
	return page
		.locator('section[data-slot="settings-group"]')
		.filter({ has: page.getByRole("heading", { name: syncText(title), exact: true }) })
}

// The newest toast whose title `matches` (`what` names it), within `timeoutMs`; its title.
export async function toastText(page: Page, what: string, matches: (title: string) => boolean, timeoutMs: number): Promise<string> {
	return waitFor(
		what,
		timeoutMs,
		async () => {
			const titles = await page.locator("[data-sonner-toast] [data-title]").allInnerTexts()

			return titles.map(title => title.replace(/\s+/g, " ").trim()).findLast(matches)
		},
		250
	)
}

// The part of a counted catalog string before its {{count}}.
function beforeCount(key: SyncKey): string {
	return SYNC_TEXT[key].split("{{count}}")[0] ?? ""
}

// The pair's page: from the sync sidebar when it shows, else through the rail's Computer group (opened from the
// keyboard) and its Sync item. The sidebar row holds the pair's name, then its phase and directories.
export async function openSyncPair(page: Page, pairName: string, timeoutMs: number): Promise<void> {
	const row = page.locator('a[href*="/sync/"]').filter({ hasText: pairName }).first()

	if (!(await row.isVisible())) {
		const computer = page.locator('[aria-label^="Computer"]').first()

		await computer.waitFor({ state: "visible", timeout: timeoutMs })
		await computer.focus()
		await page.keyboard.press("ArrowRight")
		await page.getByRole("menuitem", { name: /^Sync/ }).click({ timeout: timeoutMs })
	}

	await row.click({ timeout: timeoutMs })
}

async function openIssues(page: Page, pairName: string, timeoutMs: number): Promise<void> {
	await openSyncPair(page, pairName, timeoutMs)
	await page.getByRole("link", { name: /^Issues/ }).click({ timeout: timeoutMs })
}

// One held conflict resolved from its row (issuesTab.tsx). Done once the row is gone (the page hides it when the
// resolution succeeded; a failure leaves it, with an error toast); resolves with the success toast's text.
export async function resolveThroughIssues(
	page: Page,
	pairName: string,
	relPath: string,
	resolution: DesktopSyncResolution,
	timeoutMs: number
): Promise<string> {
	await openIssues(page, pairName, timeoutMs)

	const row = page.locator('[data-slot="settings-row"]').filter({ has: page.locator(`[title="${relPath}"]`) })
	const button = row.getByRole("button", { name: syncText(ROW_LABEL[resolution]), exact: true })

	await button.waitFor({ state: "visible", timeout: timeoutMs })

	if ((await button.count()) !== 1) {
		fail(`${String(await button.count())} ${syncText(ROW_LABEL[resolution])} buttons for ${relPath}`)
	}

	await button.click({ timeout: timeoutMs })
	await row.waitFor({ state: "detached", timeout: timeoutMs })

	const kept = syncText(KEPT[resolution])

	// Keep the cloud's may name the bin path after the same words.
	return toastText(page, `the toast "${kept}"`, title => title.startsWith(kept), timeoutMs)
}

// Every conflict of the pair resolved one way with the bulk buttons under the list (shown from two conflicts on), after
// their confirmation, which names `count`. Resolves with the toast's text once the run ended.
export async function resolveAllThroughIssues(
	page: Page,
	pairName: string,
	resolution: DesktopSyncResolution,
	count: number,
	timeoutMs: number
): Promise<string> {
	await openIssues(page, pairName, timeoutMs)

	const { label, body, kept } = BULK[resolution]

	await group(page, "issuesConflictsTitle")
		.getByRole("button", { name: syncText(label), exact: true })
		.click({ timeout: timeoutMs })

	const dialog = page.getByRole("alertdialog").filter({ hasText: syncText("conflictsResolveAllTitle") })

	await dialog.getByText(syncCount(body, count), { exact: true }).waitFor({ state: "visible", timeout: timeoutMs })
	await dialog.getByRole("button", { name: syncText(label), exact: true }).click({ timeout: timeoutMs })
	await dialog.waitFor({ state: "hidden", timeout: timeoutMs })

	// The run's end: every one kept, some (a warning, titled with how many were kept), or none (an error).
	const keptPrefix = beforeCount(`${kept}_other` as SyncKey)
	const failedEnds = [SYNC_TEXT.conflictsResolveAllFailed_one, SYNC_TEXT.conflictsResolveAllFailed_other].map(
		text => text.split("{{count}}")[1] ?? text
	)

	return toastText(
		page,
		`the bulk resolution's toast ("${syncCount(kept, count)}")`,
		title => title.startsWith(keptPrefix) || failedEnds.some(end => title.endsWith(end)),
		timeoutMs
	)
}

// The held deletions approved from the Issues tab, after the confirmation. A paused pair runs no pass, so the page says
// the approval applies on resume and keeps Approve off; `paused` asks for that and resolves with the text shown.
export async function approveHeldThroughIssues(page: Page, pairName: string, paused: boolean, timeoutMs: number): Promise<string> {
	await openIssues(page, pairName, timeoutMs)

	const held = group(page, "heldTitle")
	const approve = held.getByRole("button", { name: syncText("heldApprove"), exact: true })

	// Enabled once the held list and its pass token are read.
	await approve.click({ timeout: timeoutMs })

	const dialog = page.getByRole("alertdialog").filter({ hasText: syncText("heldApproveTitle") })

	await dialog.getByRole("button", { name: syncText("heldApprove"), exact: true }).click({ timeout: timeoutMs })
	await dialog.waitFor({ state: "hidden", timeout: timeoutMs })

	if (!paused) {
		return "approved"
	}

	const waiting = held.getByText(syncText("heldApprovedPaused"), { exact: true })

	await waiting.waitFor({ state: "visible", timeout: timeoutMs })

	if (!(await approve.isDisabled())) {
		fail(`${syncText("heldApprove")} is still enabled after the approval`)
	}

	return `"${syncText("heldApprovedPaused")}" beside a disabled ${syncText("heldApprove")}`
}

export interface ReviewExpectation {
	title: string
	findings: readonly string[]
	// A path the dry run's held list must show.
	heldPath: string
}

// A pair held for review (syncPairDetail.tsx ReviewPanel): its card's title and findings, its changes shown with ONE
// Show changes click (the lists open at once, no second button), the held list naming `heldPath`, then Start syncing.
// Done once the card is gone.
export async function startReviewThroughCard(page: Page, pairName: string, want: ReviewExpectation, timeoutMs: number): Promise<string> {
	await openSyncPair(page, pairName, timeoutMs)

	// The innermost section holding the title: the card itself.
	const card = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: want.title, exact: true }) })
		.last()

	await card.waitFor({ state: "visible", timeout: timeoutMs })

	for (const finding of want.findings) {
		await card.getByText(finding, { exact: true }).waitFor({ state: "visible", timeout: timeoutMs })
	}

	const show = card.getByRole("button", { name: syncText("reviewShowDetails"), exact: true })

	await show.click({ timeout: timeoutMs })

	const lists = card.getByRole("group", { name: syncText("reviewListsLabel"), exact: true })

	await lists.waitFor({ state: "visible", timeout: timeoutMs })

	if ((await show.count()) > 0) {
		fail(`${syncText("reviewShowDetails")} still shows after one click`)
	}

	// The held list, whichever list the switch opened on.
	await lists.getByRole("button", { name: new RegExp(`^${syncText("planListHeld")}`) }).click({ timeout: timeoutMs })
	await card.locator(`[title="${want.heldPath}"]`).waitFor({ state: "visible", timeout: timeoutMs })
	await card.getByRole("button", { name: syncText("reviewStart"), exact: true }).click({ timeout: timeoutMs })
	await card.waitFor({ state: "detached", timeout: timeoutMs })

	return `"${want.title}" with ${want.findings.map(finding => `"${finding}"`).join(", ")}; one ${syncText("reviewShowDetails")} click opened the lists (${want.heldPath} held); started`
}

const FINDING_KEY: Record<DesktopSyncReviewFinding, SyncKey> = {
	uploads: "findingUploads",
	downloads: "findingDownloads",
	conflicts: "findingConflicts",
	heldDeletions: "findingHeldDeletions",
	refused: "findingRefused",
	unconverged: "findingUnconverged",
	overwrites: "findingOverwrites"
}

// A review finding as the card lists it.
export function findingText(finding: DesktopSyncReviewFinding): string {
	return syncText(FINDING_KEY[finding])
}

const NOTICE_KEY: Record<DesktopSyncNotice, SyncKey> = {
	refusedLocalRoot: "noticeRefusedLocalRoot",
	refusedRemoteMissing: "noticeRefusedRemoteMissing",
	refusedLocalOverlap: "noticeRefusedLocalOverlap",
	refusedRemoteOverlap: "noticeRefusedRemoteOverlap",
	refusedWholeDrive: "noticeRefusedWholeDrive",
	refusedModeConflict: "noticeRefusedModeConflict"
}

// A refused pair's notice (noticeBanner.tsx): its text with Remove pair as the one way out (no hold, no Start anyway on
// the page), then removed through it. Done once the notice is gone.
export async function removeThroughNotice(page: Page, pairName: string, notice: DesktopSyncNotice, timeoutMs: number): Promise<string> {
	await openSyncPair(page, pairName, timeoutMs)

	const text = syncText(NOTICE_KEY[notice])
	const remove = page.getByRole("button", { name: syncText("noticeRemove"), exact: true })
	const callout = page.locator("div.rounded-2xl").filter({ hasText: text }).filter({ has: remove })

	await callout.waitFor({ state: "visible", timeout: timeoutMs })

	const startAnyway = await page.getByRole("button", { name: syncText("holdStartAnyway"), exact: true }).count()
	const holdText = await page.getByText(syncText("holdDriveRoot"), { exact: true }).count()

	if (startAnyway > 0 || holdText > 0) {
		fail(`the page also offers ${syncText("holdStartAnyway")} (${String(startAnyway)}) or tells the hold (${String(holdText)})`)
	}

	await callout.getByRole("button", { name: syncText("noticeRemove"), exact: true }).click({ timeout: timeoutMs })
	await callout.waitFor({ state: "detached", timeout: timeoutMs })

	return `"${text}" with ${syncText("noticeRemove")} only; removed through it`
}
