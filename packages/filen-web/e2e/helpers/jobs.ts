import type { Locator, Page, Request, Route } from "@playwright/test"
import { expect } from "../fixtures"
import { dismissOverlays, LIVE_WRITE_TIMEOUT_MS, openTransfers, toasts } from "./listing"

// The drive-job cards (copy, compress, extract) and everything a spec does with a job: wait for it,
// read it, pause, cancel, answer its password prompt, open its report, and stop whatever is left in
// a finally. Cards are sonner toasts (features/transfers/components/driveJobToast.tsx), alive while
// the job runs and a few seconds after it settles (4s clean, 8s with issues); hovering one pauses
// that countdown. While the preview overlay is open its markOthers hides the toaster from getByRole,
// so the card locators here are CSS + text, and a click on a card needs the overlay closed first.

export type JobKind = "copy" | "compress" | "extract"

// The 24 MiB legs (download-cancel.bin compressed, the gate tarball extracted): a full download plus a
// full upload, each paced by the SDK, on top of the write lease. Every other job closes inside
// LIVE_WRITE_TIMEOUT_MS.
export const ARCHIVE_JOB_TIMEOUT_MS = 180_000

const HIDE_BUTTON = /^Hide (copy|compress|extract) progress$/

// The card whose text matches `title` (a substring, or a pattern).
export function jobCard(page: Page, title: string | RegExp): Locator {
	return toasts(page)
		.filter({ has: page.getByRole("button", { name: HIDE_BUTTON, includeHidden: true }) })
		.filter({ hasText: title })
}

// Waits for the card, then hovers it so its auto-close stands still while the caller reads it.
export async function expectJobCard(page: Page, title: string | RegExp, timeout: number = ARCHIVE_JOB_TIMEOUT_MS): Promise<Locator> {
	const card = jobCard(page, title)

	await expect(card).toBeVisible({ timeout })
	await card.hover()

	return card
}

export interface CardSummary {
	extracted: number
	skipped: number
	failed: number
}

// An extract card's "N extracted · N skipped · N failed" line.
export async function readCardSummary(card: Locator): Promise<CardSummary> {
	const summary = card.getByText(/^\d+ extracted · \d+ skipped · \d+ failed$/)

	await expect(summary).toBeVisible()

	const match = /^(\d+) extracted · (\d+) skipped · (\d+) failed$/.exec((await summary.innerText()).trim())

	if (match === null) {
		throw new Error("the card's summary line did not parse")
	}

	return { extracted: Number(match[1]), skipped: Number(match[2]), failed: Number(match[3]) }
}

// Hides every card of `kinds` (all kinds by default). Bounded and tolerant: a card leaving on its own
// can detach under the click, which is fine.
export async function hideJobCards(page: Page, kinds: readonly JobKind[] = ["copy", "compress", "extract"]): Promise<void> {
	const hide = page.getByRole("button", { name: new RegExp(`^Hide (${kinds.join("|")}) progress$`) })

	for (let attempt = 0; attempt < 5 && (await hide.count()) > 0; attempt++) {
		await hide
			.first()
			.click({ timeout: 5_000 })
			.catch(() => undefined)
		await expect(hide)
			.toHaveCount(0, { timeout: 2_000 })
			.catch(() => undefined)
	}
}

export type CardButtonName =
	"Pause" | "Resume" | "Cancel" | "View report" | "Enter password" | "Try again" | "Retry failed" | "Show in directory"

export function cardButton(card: Locator, name: CardButtonName): Locator {
	return card.getByRole("button", { name, exact: true })
}

// Pauses a running job at once: a paused job is deterministic, and keeps the page's one archive slot.
export async function pauseFirst(card: Locator): Promise<void> {
	await cardButton(card, "Pause").click()
	await expect(card.getByText("Paused", { exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
}

export interface ChunkHold {
	// Lets every held request through, and every later one.
	release: () => void
	// Requests held so far.
	held: () => number
	dispose: () => Promise<void>
}

const HOST_PREFIXES = { egest: ["egest.filen"], ingest: ["ingest.filen"], both: ["egest.filen", "ingest.filen"] } as const

// Holds the SDK worker's chunk requests (downloads from egest, uploads to ingest) after the first
// `passFirst`, until release(). Chromium and Firefox route a worker's own requests; Playwright's WebKit
// sees them (observeEgest) but never routes them, so there this is null and the caller falls back to
// pauseFirst. Dispose in a finally.
export async function holdChunks(
	page: Page,
	browserName: string,
	{ hosts, passFirst = 0 }: { hosts: keyof typeof HOST_PREFIXES; passFirst?: number }
): Promise<ChunkHold | null> {
	if (browserName === "webkit") {
		return null
	}

	const prefixes: readonly string[] = HOST_PREFIXES[hosts]
	const matches = (url: URL): boolean => prefixes.some(prefix => url.hostname.startsWith(prefix))
	let seen = 0
	let heldCount = 0
	let open = false
	const waiting: (() => void)[] = []
	const release = (): void => {
		open = true

		for (const resume of waiting.splice(0)) {
			resume()
		}
	}
	const handler = async (route: Route): Promise<void> => {
		seen++

		if (!open && seen > passFirst) {
			heldCount++
			await new Promise<void>(resolve => {
				waiting.push(resolve)
			})
		}

		await route.continue().catch(() => undefined)
	}

	await page.context().route(matches, handler)

	return {
		release,
		held: () => heldCount,
		dispose: async () => {
			release()
			await page
				.context()
				.unroute(matches, handler)
				.catch(() => undefined)
		}
	}
}

// Counts download chunk requests: the positive control for "nothing was downloaded". All three engines
// report the SDK worker's requests to the context (observed on Playwright 1.63).
export function observeEgest(page: Page): { count: () => number } {
	let count = 0
	const listener = (request: Request): void => {
		try {
			if (new URL(request.url()).hostname.startsWith("egest.filen")) {
				count++
			}
		} catch {
			// an unparsable URL is no chunk
		}
	}

	page.context().on("request", listener)

	return { count: () => count }
}

export type ExtractPasswordTitle = "Password required" | "Wrong password"

function extractPasswordDialog(page: Page, title?: ExtractPasswordTitle): Locator {
	return page.getByRole("dialog", { name: title ?? /^(Password required|Wrong password)$/ })
}

// Answers the extract's password prompt (transfers/components/extractPasswordDialog.tsx).
export async function answerExtractPassword(
	page: Page,
	password: string,
	{ expectTitle, applyToAll }: { expectTitle: ExtractPasswordTitle; applyToAll?: boolean }
): Promise<void> {
	const dialog = extractPasswordDialog(page, expectTitle)

	await expect(dialog).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await dialog.getByLabel("Password", { exact: true }).fill(password)

	if (applyToAll === true) {
		const applyAll = dialog.getByRole("switch", { name: /^Also try it for the/ })

		await applyAll.click()
		await expect(applyAll).toBeChecked()
	}

	await dialog.getByRole("button", { name: "Extract", exact: true }).click()
	await expect(dialog).toHaveCount(0)
}

export async function dismissExtractPassword(page: Page): Promise<void> {
	const dialog = extractPasswordDialog(page)

	await expect(dialog).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
	await expect(dialog).toHaveCount(0)
}

// Opens the card's report; the dialog it returns is titled "Report".
export async function openReport(page: Page, card: Locator): Promise<Locator> {
	await cardButton(card, "View report").click()

	const dialog = page.getByRole("dialog", { name: "Report", exact: true })

	await expect(dialog).toBeVisible()

	return dialog
}

// A report section's heading button, whose name is the section's title then its count.
export function reportSection(dialog: Locator, title: string): Locator {
	return dialog.getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+$`) })
}

// The report's virtualized rows as rendered (only those near the scroll position are in the DOM).
export function reportRows(dialog: Locator): Locator {
	return dialog.locator(".pl-8")
}

// Best effort, never throws: closes what a failed test left standing and stops every job still
// running or paused, so the scratch directory's trash afterwards meets no lease or beforeunload. Call
// it in every write test's finally, before trashScratchDirectory.
export async function stopAllJobs(page: Page, holds: readonly (ChunkHold | null)[] = []): Promise<void> {
	try {
		for (const hold of holds) {
			await hold?.dispose()
		}

		await dismissOverlays(page)
		await openTransfers(page)

		const cancelAll = page.getByRole("button", { name: "Cancel all", exact: true })

		if (await cancelAll.isEnabled().catch(() => false)) {
			await cancelAll.click()

			const confirm = page.getByRole("alertdialog", { name: "Cancel all transfers?" })

			await confirm.getByRole("button", { name: "Cancel all", exact: true }).click()
			await expect(confirm).toHaveCount(0)
			await expect(cancelAll).toBeDisabled({ timeout: LIVE_WRITE_TIMEOUT_MS })
		}

		await hideJobCards(page)
	} catch (error) {
		console.warn("stopAllJobs: could not stop every job", error)
	}
}
