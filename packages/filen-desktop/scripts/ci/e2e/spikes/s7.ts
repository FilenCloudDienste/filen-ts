import { existsSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { errorMessage, fail, runBounded, waitFor, type BoundedResult } from "../../support.ts"
import { fileProviderState, fileProviderToggle, fileProviderUserEnabled, pageText, sessionStatus, signIn, signOut } from "../app.ts"
import { quarantineOf } from "../mac.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import { launchDebuggable } from "../launch.ts"
import { redactor } from "../redact.ts"
import { installFrom, START_TIMEOUT_MS, tail } from "../update.ts"
import { createFindings, type SpikeOptions } from "../findings.ts"
import { takeCredentials } from "../session.ts"

// Spike S7: can Filen in Finder be switched on with nobody at the Mac? macOS may register the File Provider domain with
// userEnabled false, which a person flips in System Settings. On a signed, unnotarized N: sign in through the real form
// (once; never retried, logins are rate-limited per account), enable through the window.desktop contract, read
// userEnabled, try pluginkit, then an off/on round trip, and if the domain ends up enabled, list it. On hosted runners
// userEnabled stays false (a person switches it on in System Settings), which is reported as information; the checks
// are the sign-in, state(), enable(), the round trip and the domain's registration. Every run that stored a session
// signs out through the app's own account menu, closing whatever covers the shell first. Evidence: findings, main.log and
// the subsystem log (fileproviderctl is left out: it hangs on hosted runners). Every system tool runs bounded.

const APPEX_ID = "io.filen.desktop.FileProvider"
const DOMAIN_TIMEOUT_MS = 60_000
const LISTING_TIMEOUT_MS = 2 * 60 * 1000
const TOOL_TIMEOUT_MS = 60_000

function output(result: BoundedResult): string {
	const status = result.timedOut ? "timed out (process group killed)" : `exit ${String(result.status)}`

	return `${status}\n${result.stdout}\n${result.stderr}`.trim()
}

function tool(command: string, args: string[], timeoutMs = TOOL_TIMEOUT_MS): Promise<BoundedResult> {
	return runBounded(command, args, timeoutMs)
}

export async function runS7({ target, nextDir, nextVersion, signed, artifacts }: SpikeOptions): Promise<void> {
	if (target.platform !== "mac") {
		fail("S7 runs on macOS only")
	}

	if (!signed) {
		fail("S7 needs a Developer-ID-signed build (dispatch with signed: true or profile: nightly)")
	}

	// Nothing started from here (the app, pluginkit, log) inherits them.
	const { email, password } = takeCredentials()

	const findings = createFindings("s7", artifacts, redactor([email, password]))
	const app = path.resolve(target.executable, "..", "..", "..")
	// Set as the run gets there; the cleanup acts on them.
	const reached: { renderer?: Renderer; submitted?: boolean } = {}

	const drive = async (): Promise<void> => {
		installFrom(target, path.join(nextDir, target.installer), nextVersion, true)
		findings.info("macOS", (await tool("sw_vers", ["-productVersion"])).stdout.trim())

		await findings.check("the installed app carries no quarantine", async () => {
			const attribute = await quarantineOf(target)

			if (attribute !== null) {
				fail(`quarantined: ${attribute}`)
			}

			return "no com.apple.quarantine attribute"
		})
		findings.info("Gatekeeper assessment (information)", output(await tool("spctl", ["-a", "-vv", app])))

		const launched = await launchDebuggable(target)

		reached.renderer = await connectRenderer(launched.debugPort, "filen://app", START_TIMEOUT_MS)

		const { page } = reached.renderer
		const signedIn = await findings.check("sign in through the 4.x form (one attempt)", async () => {
			try {
				reached.submitted = true

				return await signIn(page, email, password, START_TIMEOUT_MS)
			} catch (error) {
				findings.attach("s7-sign-in-page.txt", await pageText(page, 4000))

				throw error
			}
		})

		if (!signedIn) {
			return
		}

		await findings.check("fileProvider.state(): supported, not translocated, no PIN", async () => {
			const before = await fileProviderState(page)

			if (!before.supported || before.translocated || before.lockBlocked) {
				fail(JSON.stringify(before))
			}

			return JSON.stringify(before)
		})

		const enabled = await findings.check("fileProvider.enable()", () => fileProviderToggle(page, "enable"))

		if (!enabled) {
			return
		}

		const first = await fileProviderUserEnabled(page, DOMAIN_TIMEOUT_MS).catch((error: unknown) => errorMessage(error))

		findings.info("userEnabled right after the first add", String(first))
		findings.info("pluginkit election", output(await tool("pluginkit", ["-m", "-v", "-i", APPEX_ID])))

		if (first !== true) {
			findings.info("pluginkit -e use", output(await tool("pluginkit", ["-e", "use", "-i", APPEX_ID])))
			findings.info("pluginkit election after -e use", output(await tool("pluginkit", ["-m", "-v", "-i", APPEX_ID])))
			findings.info("userEnabled after pluginkit -e use", String((await fileProviderState(page)).userEnabled))
		}

		// Removing and adding the domain again: the extension and its XPC answer, and macOS decides userEnabled anew.
		await findings.check(
			"disable() then enable() round trip",
			async () => `${await fileProviderToggle(page, "disable")} / ${await fileProviderToggle(page, "enable")}`
		)

		const last = await fileProviderUserEnabled(page, DOMAIN_TIMEOUT_MS).catch((error: unknown) => errorMessage(error))

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
			await fileProviderToggle(renderer.page, "disable").catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))

			const status = submitted === true ? await sessionStatus(renderer.page).catch(errorMessage) : "not submitted"

			if (status === "present") {
				await findings.check("sign out through the app", () => signOut(renderer.page, findings, email, artifacts, "s7"))
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
