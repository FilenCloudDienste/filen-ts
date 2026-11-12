import path from "node:path"
import type { DesktopFileProviderResult, DesktopFileProviderState } from "@filen/shared/desktop"
import type { Page } from "playwright-core"
import { errorMessage, fail, waitFor } from "../support.ts"
import type { Findings } from "./findings.ts"
import { resolveThroughIssues } from "./syncUi.ts"

// The 4.x page, driven over CDP: the real sign-in and sign-out forms, the lock screen, and reads of the window.desktop
// contract (@filen/shared/desktop). Every read crosses CDP as a derived, non-secret value.

export const APP_ORIGIN = "filen://app"
export const SIGN_IN_TIMEOUT_MS = 2 * 60 * 1000
const SIGN_OUT_TIMEOUT_MS = 2 * 60 * 1000

// How long a contract call may take unless the caller says otherwise: every one answers in seconds, a plan included.
export const CONTRACT_TIMEOUT_MS = 2 * 60 * 1000

// `run` within `timeoutMs`, else a failure naming `what`. The page keeps the call; the harness stops waiting for it.
async function within<T>(what: string, timeoutMs: number, run: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined

	try {
		return await Promise.race([
			run,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${what}: no answer in ${String(Math.round(timeoutMs / 1000))} s`)), timeoutMs)
			})
		])
	} finally {
		clearTimeout(timer)
	}
}

// `expression` (a promise or value in the page) as JSON-parsed data, within `timeoutMs`. The value crosses CDP
// wrapped, so a call that resolves to nothing fails by name instead of handing JSON.parse the text "undefined"; calls
// that return nothing by contract go through desktopCall.
export async function desktop<T>(page: Page, expression: string, timeoutMs = CONTRACT_TIMEOUT_MS): Promise<T> {
	const text: unknown = await within(
		expression,
		timeoutMs,
		page.evaluate(`(async () => JSON.stringify({ value: await ${expression} }))()`)
	)

	if (typeof text !== "string") {
		fail(`${expression}: the page answered ${typeof text}`)
	}

	const { value } = JSON.parse(text) as { value?: T }

	if (value === undefined) {
		fail(`${expression} resolved to nothing`)
	}

	return value
}

// A contract call that resolves to nothing (releasePlan, dismissNotice, ...): awaited in the page, nothing returned.
export async function desktopCall(page: Page, expression: string, timeoutMs = CONTRACT_TIMEOUT_MS): Promise<void> {
	await within(expression, timeoutMs, page.evaluate(`(async () => { await ${expression} })()`))
}

export function sessionStatus(page: Page): Promise<string> {
	return desktop<string>(page, "window.desktop.session.get().then(read => read.status)")
}

export async function pageText(page: Page, limit: number): Promise<string> {
	return String(await page.evaluate("document.body.innerText").catch(errorMessage)).slice(0, limit)
}

// The real form, one attempt: logins are rate-limited per account and never retried. Done when the vault holds the
// session.
export async function signIn(page: Page, email: string, password: string, startTimeoutMs: number): Promise<string> {
	await page.getByText("Sign in to Filen").waitFor({ state: "visible", timeout: startTimeoutMs })
	await page.getByLabel("Email", { exact: true }).fill(email)
	await page.getByLabel("Password", { exact: true }).fill(password)
	await page.getByRole("button", { name: "Sign in", exact: true }).click()
	await waitFor("the session to be stored", SIGN_IN_TIMEOUT_MS, async () => ((await sessionStatus(page)) === "present" ? true : null))

	return "session.get() status: present"
}

// The startup reminder a fresh session shows, modal over the shell (filen-web).
export const MASTER_KEYS_REMINDER = "Back up your master keys"

// Puts the reminder off with its own "Remind me later" when it shows within `timeoutMs`; whether it showed.
export async function putOffKeysReminder(page: Page, timeoutMs: number): Promise<boolean> {
	const reminder = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: MASTER_KEYS_REMINDER }).first()

	try {
		await reminder.waitFor({ state: "visible", timeout: timeoutMs })
	} catch {
		return false
	}

	await reminder.getByRole("button", { name: "Remind me later", exact: true }).click({ timeout: 30_000 })
	await reminder.waitFor({ state: "hidden", timeout: 30_000 })

	return true
}

// Names of buttons that close what may cover the shell after a sign-in (startup reminders, notices, callouts) without
// acting on it. Anything else is closed with Escape.
const DISMISS = /^(Remind me later|OK|Not now|Later|Skip|Close|Dismiss|Got it|Cancel)$/i
const DIALOGS = '[role="dialog"], [role="alertdialog"]'

// Closes every open dialog, recording each distinct one's text as information.
export async function clearDialogs(page: Page, findings: Findings, seen: Set<string>): Promise<void> {
	for (let round = 0; round < 6; round++) {
		const dialog = page.locator(DIALOGS).filter({ visible: true }).last()

		if ((await dialog.count()) === 0) {
			return
		}

		const text = (await dialog.innerText().catch(errorMessage)).replace(/\s+/g, " ").slice(0, 300)

		if (!seen.has(text)) {
			seen.add(text)
			findings.info("dialog over the shell", text)
		}

		const dismiss = dialog.getByRole("button", { name: DISMISS }).first()

		if ((await dismiss.count()) > 0) {
			await dismiss.click({ timeout: 10_000 }).catch(() => page.keyboard.press("Escape"))
		} else {
			await page.keyboard.press("Escape")
		}

		await page.waitForTimeout(500)
	}
}

// The app's own sign-out: account menu, then the confirm dialog, once whatever covers the shell is closed. Done when
// the vault reports no session and the sign-in form is back. On failure: a screenshot with the email masked, and the
// page's text, both as artifacts.
export async function signOut(page: Page, findings: Findings, email: string, artifacts: string, label: string): Promise<string> {
	try {
		const account = page.getByRole("button", { name: "Account", exact: true })
		const seen = new Set<string>()

		await waitFor(
			"the account button (closing dialogs over the shell)",
			SIGN_OUT_TIMEOUT_MS,
			async () => {
				await clearDialogs(page, findings, seen)

				return (await account.isVisible()) ? true : null
			},
			2000
		)
		await account.click({ timeout: 30_000 })
		await page.getByRole("menu").getByRole("menuitem", { name: "Sign out", exact: true }).click({ timeout: 30_000 })
		await page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click({ timeout: 30_000 })
		await page.getByText("Sign in to Filen").waitFor({ state: "visible", timeout: SIGN_OUT_TIMEOUT_MS })
		await waitFor("the vault to hold no session", SIGN_OUT_TIMEOUT_MS, async () =>
			(await sessionStatus(page)) === "absent" ? true : null
		)

		return "signed out through the account menu; session.get() status: absent"
	} catch (error) {
		await page
			.screenshot({ path: path.join(artifacts, `${label}-sign-out-failure.png`), mask: [page.getByText(email)] })
			.catch((shot: unknown) => console.log(`screenshot: ${errorMessage(shot)}`))
		findings.attach(`${label}-sign-out-page.txt`, await pageText(page, 8000))

		throw error
	}
}

// Filen in Finder (macOS): its state, and switching it on or off, which must be accepted.
export function fileProviderState(page: Page): Promise<DesktopFileProviderState> {
	return desktop<DesktopFileProviderState>(page, "window.desktop.fileProvider.state()")
}

export async function fileProviderToggle(page: Page, action: "enable" | "disable"): Promise<string> {
	const result = await desktop<DesktopFileProviderResult<DesktopFileProviderState>>(page, `window.desktop.fileProvider.${action}()`)

	if (!result.ok) {
		fail(`${action}() refused: ${JSON.stringify(result.error)}`)
	}

	return JSON.stringify(result.value)
}

// userEnabled once macOS reports one for the user's domain (it registers the domain asynchronously).
export function fileProviderUserEnabled(page: Page, timeoutMs: number): Promise<boolean> {
	return waitFor("macOS to report userEnabled for the domain", timeoutMs, async () => (await fileProviderState(page)).userEnabled, 2000)
}

// `run` with the master-key reminder put off whenever it covers a step: modal over the shell, it may show at any point
// of a launch. Resolves with run's value and how often the reminder was put off.
//
// The handler never throws: Playwright calls it from a protocol event listener with no catch, so a rejection there is
// unhandled and ends the whole harness process, every later check and the findings with it. A reminder it could not
// put off is logged with what the dialog held; the action that ran into it then fails on its own, inside its check.
export async function underReminder<T>(page: Page, run: () => Promise<T>): Promise<{ value: T; putOff: number }> {
	const reminder = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: MASTER_KEYS_REMINDER })
	let putOff = 0

	await page.addLocatorHandler(reminder, async dialog => {
		try {
			await dialog.getByRole("button", { name: "Remind me later", exact: true }).click({ timeout: 30_000 })
			putOff++
		} catch (error) {
			const hidden = await dialog.evaluate(element => element.closest('[aria-hidden="true"]') !== null).catch(errorMessage)
			const text = (await dialog.innerText().catch(errorMessage)).replace(/\s+/g, " ").slice(0, 300)

			console.log(`reminder not put off: ${errorMessage(error)}; inside aria-hidden: ${String(hidden)}; dialog: "${text}"`)
		}
	})

	try {
		return { value: await run(), putOff }
	} finally {
		await page.removeLocatorHandler(reminder)
	}
}

// A held sync conflict resolved with Keep both as a user does (syncUi.ts resolveThroughIssues), the reminder put off
// whenever it covers a step. Resolves with how often it was and the success toast's text.
export async function keepBothThroughIssues(
	page: Page,
	pairName: string,
	relPath: string,
	timeoutMs: number
): Promise<{ putOff: number; toast: string }> {
	const { putOff, value } = await underReminder(page, () => resolveThroughIssues(page, pairName, relPath, "keepBoth", timeoutMs))

	return { putOff, toast: value }
}

// The lock screen's PIN field (filen-web desktopLock.tsx), then its Unlock button.
export async function unlockThroughScreen(page: Page, pin: string, timeoutMs: number): Promise<void> {
	const field = page.getByLabel("PIN", { exact: true })

	await field.waitFor({ state: "visible", timeout: timeoutMs })
	await field.fill(pin)
	await page.getByRole("button", { name: "Unlock", exact: true }).click({ timeout: 30_000 })
}
