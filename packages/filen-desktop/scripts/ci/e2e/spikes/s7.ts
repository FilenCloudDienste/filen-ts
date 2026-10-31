import { existsSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Page } from "playwright-core"
import { errorMessage, fail, runBounded, waitFor, type BoundedResult } from "../../support.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import { launchDebuggable } from "../launch.ts"
import { redactor } from "../redact.ts"
import { installFrom, START_TIMEOUT_MS, tail } from "../update.ts"
import { createFindings, type Findings, type SpikeOptions } from "./findings.ts"

// Spike S7: can Filen in Finder be switched on with nobody at the Mac? macOS may register the File Provider domain with
// userEnabled false, which a person flips in System Settings. On a signed, unnotarized N: sign in through the real form
// (once; never retried, logins are rate-limited per account), enable through the window.desktop contract, read
// userEnabled, try pluginkit, then an off/on round trip, and if the domain ends up enabled, list it. On hosted runners
// userEnabled stays false (a person switches it on in System Settings), which is reported as information; the checks
// are the sign-in, state(), enable(), the round trip and the domain's registration. Every run that stored a session
// signs out through the app's own account menu, closing whatever covers the shell first. Evidence: findings, main.log and
// the subsystem log (fileproviderctl is left out: it hangs on hosted runners). Every system tool runs bounded.

const EMAIL_ENV = "FILEN_DESKTOP_E2E_TEST_EMAIL"
const PASSWORD_ENV = "FILEN_DESKTOP_E2E_TEST_PASSWORD"
const APPEX_ID = "io.filen.desktop.FileProvider"
const SIGN_IN_TIMEOUT_MS = 2 * 60 * 1000
const SIGN_OUT_TIMEOUT_MS = 2 * 60 * 1000
const DOMAIN_TIMEOUT_MS = 60_000
const LISTING_TIMEOUT_MS = 2 * 60 * 1000
const TOOL_TIMEOUT_MS = 60_000

interface FileProviderState {
	supported: boolean
	enabled: boolean
	lockBlocked: boolean
	userEnabled: boolean | null
	translocated: boolean
}

// Every read crosses CDP as a derived, non-secret value.
async function evaluate(page: Page, expression: string): Promise<string> {
	return String(await page.evaluate(`(async () => JSON.stringify(await ${expression}))()`))
}

async function sessionStatus(page: Page): Promise<unknown> {
	return JSON.parse(await evaluate(page, "window.desktop.session.get().then(read => read.status)"))
}

async function state(page: Page): Promise<FileProviderState> {
	return JSON.parse(await evaluate(page, "window.desktop.fileProvider.state()")) as FileProviderState
}

async function toggle(page: Page, action: "enable" | "disable"): Promise<string> {
	const result = await evaluate(page, `window.desktop.fileProvider.${action}()`)

	if ((JSON.parse(result) as { ok?: unknown }).ok !== true) {
		fail(`${action}() refused: ${result}`)
	}

	return result
}

// userEnabled once macOS reports one for the user's domain.
function userEnabled(page: Page): Promise<boolean> {
	return waitFor("macOS to report userEnabled for the domain", DOMAIN_TIMEOUT_MS, async () => (await state(page)).userEnabled, 2000)
}

function output(result: BoundedResult): string {
	const status = result.timedOut ? "timed out (process group killed)" : `exit ${String(result.status)}`

	return `${status}\n${result.stdout}\n${result.stderr}`.trim()
}

function tool(command: string, args: string[], timeoutMs = TOOL_TIMEOUT_MS): Promise<BoundedResult> {
	return runBounded(command, args, timeoutMs)
}

// Names of buttons that close what may cover the shell after a sign-in (startup reminders, notices, callouts) without
// acting on it. Anything else is closed with Escape.
const DISMISS = /^(Remind me later|OK|Not now|Later|Skip|Close|Dismiss|Got it|Cancel)$/i
const DIALOGS = '[role="dialog"], [role="alertdialog"]'

// Closes every open dialog, recording each distinct one's text (redacted by the findings) as information.
async function clearDialogs(page: Page, findings: Findings, seen: Set<string>): Promise<void> {
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
async function signOut(page: Page, findings: Findings, email: string, artifacts: string): Promise<string> {
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
			.screenshot({ path: path.join(artifacts, "s7-sign-out-failure.png"), mask: [page.getByText(email)] })
			.catch((shot: unknown) => console.log(`screenshot: ${errorMessage(shot)}`))
		findings.attach("s7-sign-out-page.txt", String(await page.evaluate("document.body.innerText").catch(errorMessage)).slice(0, 8000))

		throw error
	}
}

export async function runS7({ target, nextDir, nextVersion, signed, artifacts }: SpikeOptions): Promise<void> {
	if (target.platform !== "mac") {
		fail("S7 runs on macOS only")
	}

	if (!signed) {
		fail("S7 needs a Developer-ID-signed build (dispatch with signed: true or profile: nightly)")
	}

	const email = process.env[EMAIL_ENV] ?? ""
	const password = process.env[PASSWORD_ENV] ?? ""

	if (email === "" || password === "") {
		fail(`${EMAIL_ENV} and ${PASSWORD_ENV} must be set`)
	}

	// Nothing started from here (the app, pluginkit, log) inherits them.
	delete process.env[EMAIL_ENV]
	delete process.env[PASSWORD_ENV]

	const findings = createFindings("s7", artifacts, redactor([email, password]))
	const app = path.resolve(target.executable, "..", "..", "..")
	// Set as the run gets there; the cleanup acts on them.
	const reached: { renderer?: Renderer; submitted?: boolean } = {}

	const drive = async (): Promise<void> => {
		installFrom(target, path.join(nextDir, target.installer), nextVersion, true)
		findings.info("macOS", (await tool("sw_vers", ["-productVersion"])).stdout.trim())

		await findings.check("the installed app carries no quarantine", async () => {
			const xattr = await tool("xattr", ["-p", "com.apple.quarantine", app])

			if (xattr.status === 0) {
				fail(`quarantined: ${xattr.stdout.trim()}`)
			}

			return "no com.apple.quarantine attribute"
		})
		findings.info("Gatekeeper assessment (information)", output(await tool("spctl", ["-a", "-vv", app])))

		const launched = await launchDebuggable(target)

		reached.renderer = await connectRenderer(launched.debugPort, "filen://app", START_TIMEOUT_MS)

		const { page } = reached.renderer
		const signedIn = await findings.check("sign in through the 4.x form (one attempt)", async () => {
			try {
				await page.getByText("Sign in to Filen").waitFor({ state: "visible", timeout: START_TIMEOUT_MS })
				await page.getByLabel("Email", { exact: true }).fill(email)
				await page.getByLabel("Password", { exact: true }).fill(password)
				reached.submitted = true
				await page.getByRole("button", { name: "Sign in", exact: true }).click()
				await waitFor("the session to be stored", SIGN_IN_TIMEOUT_MS, async () =>
					(await sessionStatus(page)) === "present" ? true : null
				)

				return "session.get() status: present"
			} catch (error) {
				findings.attach(
					"s7-sign-in-page.txt",
					String(await page.evaluate("document.body.innerText").catch(errorMessage)).slice(0, 4000)
				)

				throw error
			}
		})

		if (!signedIn) {
			return
		}

		await findings.check("fileProvider.state(): supported, not translocated, no PIN", async () => {
			const before = await state(page)

			if (!before.supported || before.translocated || before.lockBlocked) {
				fail(JSON.stringify(before))
			}

			return JSON.stringify(before)
		})

		const enabled = await findings.check("fileProvider.enable()", () => toggle(page, "enable"))

		if (!enabled) {
			return
		}

		const first = await userEnabled(page).catch((error: unknown) => errorMessage(error))

		findings.info("userEnabled right after the first add", String(first))
		findings.info("pluginkit election", output(await tool("pluginkit", ["-m", "-v", "-i", APPEX_ID])))

		if (first !== true) {
			findings.info("pluginkit -e use", output(await tool("pluginkit", ["-e", "use", "-i", APPEX_ID])))
			findings.info("pluginkit election after -e use", output(await tool("pluginkit", ["-m", "-v", "-i", APPEX_ID])))
			findings.info("userEnabled after pluginkit -e use", String((await state(page)).userEnabled))
		}

		// Removing and adding the domain again: the extension and its XPC answer, and macOS decides userEnabled anew.
		await findings.check(
			"disable() then enable() round trip",
			async () => `${await toggle(page, "disable")} / ${await toggle(page, "enable")}`
		)

		const last = await userEnabled(page).catch((error: unknown) => errorMessage(error))

		// The answer S7 found: macOS registers the domain with userEnabled false and nothing headless (pluginkit, re-adding
		// the domain) turns it on, so listing, download and upload through Finder stay a manual release check. Reported,
		// not failed; registration itself must hold.
		await findings.check("the domain is registered (macOS reports userEnabled)", () => {
			if (typeof last !== "boolean") {
				fail(last)
			}

			return `userEnabled ${String(last)}`
		})
		findings.info(
			"userEnabled with nobody at the Mac",
			last === true ? "true: the domain is usable headless" : `${String(last)}: switching it on needs a person (System Settings)`
		)

		if (last === true) {
			await findings.check("the domain directory lists the account", async () => {
				const cloudStorage = path.join(os.homedir(), "Library", "CloudStorage")
				const domain = await waitFor("the domain directory under ~/Library/CloudStorage", LISTING_TIMEOUT_MS, () =>
					existsSync(cloudStorage) ? readdirSync(cloudStorage).find(name => name.startsWith("Filen")) : null
				)
				// A process reading another app's File Provider domain may meet a privacy prompt; bounded, never hung.
				const listing = await tool("ls", ["-1", path.join(cloudStorage, domain)], LISTING_TIMEOUT_MS)

				if (listing.status !== 0) {
					fail(`ls ${domain}: ${output(listing)}`)
				}

				return `${domain}: ${String(listing.stdout.split("\n").filter(line => line !== "").length)} entries at the root`
			})
		}
	}

	try {
		await drive()
	} catch (error) {
		await findings.check("the spike ran to the end", () => fail(errorMessage(error)))
	} finally {
		const { renderer, submitted } = reached

		if (renderer) {
			// The domain goes with every file it replicated, then the session: never left signed in.
			await toggle(renderer.page, "disable").catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))

			const status = submitted === true ? await sessionStatus(renderer.page).catch(errorMessage) : "not submitted"

			if (status === "present") {
				await findings.check("sign out through the app", () => signOut(renderer.page, findings, email, artifacts))
			} else {
				findings.info("sign out through the app", `nothing to sign out (session: ${String(status)})`)
			}
		}

		// main.log lives in userData/logs (src/main/index.ts createFileLog); read before the reset removes it.
		findings.attach("s7-main.log", tail(path.join(target.userData, "logs", "main.log"), 1000))

		for (const [name, command, args] of [
			[
				"s7-filen-subsystem.log",
				"log",
				["show", "--style", "compact", "--last", "15m", "--predicate", 'subsystem BEGINSWITH "io.filen"']
			]
		] as const) {
			findings.attach(name, output(await tool(command, [...args])))
		}

		await renderer?.browser.close().catch(() => undefined)

		try {
			target.reset()
		} catch (error) {
			console.log(`cleanup: ${errorMessage(error)}`)
		}
	}

	findings.finish()
}
