import path from "node:path"
import { LEGACY_VERSION } from "../../legacy.ts"
import { errorMessage, fail, startXvfb, waitFor } from "../../support.ts"
import type { Target } from "../../targets.ts"
import { connectCdp, listTargets, type Cdp } from "../cdp/inspector.ts"
import { connectRenderer } from "../cdp/renderer.ts"
import { exitWithin, launchDebuggable, type Launched } from "../launch.ts"
import { installFrom, legacyInstaller, legacyLogOf, START_TIMEOUT_MS, tail } from "../update.ts"
import { createFindings, type Findings, type SpikeOptions } from "./findings.ts"

// Spike S1: can the packaged apps be driven from outside? Both run with devTools disabled, so the question is whether
// their pages are still listed and evaluable over --remote-debugging-port and playwright-core attaches; for 3.0.53 also
// whether its main process answers --inspect (it has no fuses) and quits through app.quit() from there; for N whether
// SIGTERM quits it gracefully (exit code 0, no signal), which is how the e2e will quit it on macOS and Linux.

const EXIT_TIMEOUT_MS = 60_000
const PAGE_FACTS =
	"JSON.stringify({ origin: location.origin, readyState: document.readyState, crossOriginIsolated: globalThis.crossOriginIsolated, " +
	"desktop: typeof globalThis.desktop, desktopAPI: typeof globalThis.desktopAPI })"
const MAIN_FACTS = 'JSON.stringify({ electron: process.versions.electron, app: process.mainModule.require("electron").app.getVersion() })'
// A value nobody could mistake for a credential; typed and read back to prove the form is drivable.
const PROBE_TEXT = "probe@example.invalid"

interface App {
	label: string
	slug: string
	origin: string
	legacy: boolean
}

function running(launched: Launched): boolean {
	return launched.child.exitCode === null && launched.child.signalCode === null
}

async function probeApp(findings: Findings, target: Target, app: App, artifacts: string): Promise<void> {
	const launched = await launchDebuggable(target, app.legacy)
	const page: { url?: string | undefined } = {}

	await findings.check(`${app.label}: the devTools:false page is listed on --remote-debugging-port`, async () => {
		const targets = await waitFor(`a page at ${app.origin} on port ${String(launched.debugPort)}`, START_TIMEOUT_MS, async () => {
			const list = await listTargets(launched.debugPort)

			return list?.some(entry => entry.type === "page" && entry.url.startsWith(app.origin)) ? list : null
		})

		page.url = targets.find(entry => entry.type === "page" && entry.url.startsWith(app.origin))?.webSocketDebuggerUrl

		return targets.map(entry => `${entry.type} ${entry.url.split(/[?#]/)[0] ?? ""}`).join(", ")
	})

	await findings.check(`${app.label}: raw CDP Runtime.evaluate works in that page`, async () => {
		const cdp = await connectCdp(page.url ?? fail("the page lists no webSocketDebuggerUrl"))

		try {
			return String(await cdp.evaluate(PAGE_FACTS))
		} finally {
			cdp.close()
		}
	})

	await findings.check(`${app.label}: playwright-core attaches with connectOverCDP and the sign-in form is drivable`, async () => {
		const { browser, page: renderer } = await connectRenderer(launched.debugPort, app.origin, START_TIMEOUT_MS)

		try {
			const email = app.legacy ? renderer.locator("input#email") : renderer.getByLabel("Email", { exact: true })

			await email.waitFor({ state: "visible", timeout: START_TIMEOUT_MS })
			await renderer.screenshot({ path: path.join(artifacts, `s1-${app.slug}-page.png`) })
			await email.fill(PROBE_TEXT)

			const typed = await email.inputValue()

			if (typed !== PROBE_TEXT) {
				fail(`the email field holds "${typed}" after fill`)
			}

			await email.fill("")

			return `${renderer.url().split(/[?#]/)[0] ?? ""}: email field visible, filled and read back`
		} finally {
			// A connectOverCDP browser only disconnects; the app keeps running.
			await browser.close()
		}
	})

	if (app.legacy) {
		const inspector: { cdp?: Cdp } = {}

		await findings.check(`${app.label}: the main process answers --inspect`, async () => {
			const port = launched.inspectPort ?? fail("no inspector port")
			const targets = await waitFor(`the inspector on port ${String(port)}`, START_TIMEOUT_MS, async () => {
				const list = await listTargets(port)

				return list?.some(entry => entry.webSocketDebuggerUrl !== undefined) ? list : null
			})

			inspector.cdp = await connectCdp(targets.find(entry => entry.webSocketDebuggerUrl !== undefined)?.webSocketDebuggerUrl ?? "")

			const facts = String(await inspector.cdp.evaluate(MAIN_FACTS))
			const version = (JSON.parse(facts) as { app?: unknown }).app

			if (version !== LEGACY_VERSION) {
				fail(`app.getVersion() is ${String(version)}, expected ${LEGACY_VERSION}`)
			}

			return facts
		})

		// 3.x's own graceful quit (tray Quit, Cmd+Q) is app.quit(): before-quit lets the window close, will-quit flushes
		// rclone and ends in app.exit(0). The quit is scheduled and the session closed first, because Node holds a process
		// at exit while a debugger session is attached ("Waiting for the debugger to disconnect").
		await findings.check(`${app.label}: app.quit() through the inspector quits it`, async () => {
			const cdp = inspector.cdp ?? fail("no inspector connection")

			try {
				await cdp.evaluate('setTimeout(() => process.mainModule.require("electron").app.quit(), 500), "scheduled"')
			} finally {
				cdp.close()
			}

			const exit = await exitWithin(launched, EXIT_TIMEOUT_MS)

			if (exit === null) {
				fail(`still running ${String(EXIT_TIMEOUT_MS / 1000)} s after app.quit()`)
			}

			return `exited with code ${String(exit.code)}, signal ${String(exit.signal)}`
		})
	} else if (target.platform === "win") {
		findings.info(`${app.label}: SIGTERM`, "not applicable: Windows has no signals")
	} else {
		await findings.check(`${app.label}: SIGTERM quits it gracefully`, async () => {
			if (!running(launched)) {
				fail(`it had already exited (code ${String(launched.child.exitCode)}, signal ${String(launched.child.signalCode)})`)
			}

			launched.child.kill("SIGTERM")

			const exit = await exitWithin(launched, EXIT_TIMEOUT_MS)

			if (exit === null) {
				fail(`still running ${String(EXIT_TIMEOUT_MS / 1000)} s after SIGTERM`)
			}

			if (exit.code !== 0 || exit.signal !== null) {
				fail(`exited with code ${String(exit.code)}, signal ${String(exit.signal)}: not a graceful quit`)
			}

			return "exited with code 0"
		})
	}

	findings.attach(
		`s1-${app.slug}.log`,
		app.legacy ? tail(legacyLogOf(target), 400) : tail(path.join(target.userData, "logs", "main.log"), 400)
	)
}

export async function runS1({ target, nextDir, nextVersion, signed, work, artifacts }: SpikeOptions): Promise<void> {
	const findings = createFindings("s1", artifacts)
	const xvfb = target.platform === "linux" ? await startXvfb() : null
	const apps: (App & { install(): Promise<void> })[] = [
		{
			label: LEGACY_VERSION,
			slug: "legacy",
			origin: "filendesktop://bundle",
			legacy: true,
			// 3.0.53 is a signed release on Windows and macOS.
			install: async () => installFrom(target, await legacyInstaller(target, work), LEGACY_VERSION, target.platform !== "linux")
		},
		{
			label: `N ${nextVersion}`,
			slug: "next",
			origin: "filen://app",
			legacy: false,
			install: async () => installFrom(target, path.join(nextDir, target.installer), nextVersion, signed)
		}
	]

	try {
		for (const app of apps) {
			try {
				await app.install()
				await probeApp(findings, target, app, artifacts)
			} catch (error) {
				await findings.check(`${app.label}: install and launch`, () => fail(errorMessage(error)))
			}
		}
	} finally {
		try {
			target.reset()
		} catch (error) {
			console.log(`cleanup: ${errorMessage(error)}`)
		}

		xvfb?.kill()
	}

	findings.finish()
}
