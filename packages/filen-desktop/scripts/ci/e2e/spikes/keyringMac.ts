import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { LEGACY_VERSION } from "../../legacy.ts"
import { errorMessage, fail, runBounded, type BoundedResult } from "../../support.ts"
import { connectRenderer } from "../cdp/renderer.ts"
import { readJson } from "../chains/common.ts"
import { createFindings, type SpikeOptions } from "../findings.ts"
import { cipherSeen, keychainLines, keyringSeed, seedKeyringLegacy, seedRedacted } from "../keyringData.ts"
import { launchDebuggable, type Launched } from "../launch.ts"
import { LEGACY_ORIGIN, quitLegacy } from "../legacyApp.ts"
import { macOs } from "../mac.ts"
import { offlineBlockFor } from "../offlineBlock.ts"
import { redactor } from "../redact.ts"
import { mask } from "../session.ts"
import { installFrom, legacyInstaller, START_TIMEOUT_MS } from "../update.ts"

// Spike keyring-mac (gap 2): what Electron 45's safeStorage does on macOS when the keychain holding "Filen Safe
// Storage" is locked as N starts, and what B1's import (src/main/migration.ts) makes of it. A dedicated keychain with a
// random password is made the default (and first in the search list) before 3.0.53 runs, so every item of the run lands
// there and nothing touches the runner's login keychain. 3.0.53 gets chain K's synthetic signed-in profile
// (keyringData.ts; no account, no sign-in), N is installed over it (no updater), the keychain is locked, and N
// starts behind the offline block. Recorded as information, sampled every few seconds: whether SecurityAgent (the
// keychain's unlock prompt) runs, what main logged about safeStorage and the import, and the marker; screenshots of the
// whole screen. Then the prompt is cancelled (SecurityAgent killed), the keychain unlocked from outside (security
// unlock-keychain), and N started once more unlocked. SecurityAgent is always killed in the cleanup, the keychain
// deleted and the old defaults put back. Every tool runs bounded.

const TOOL_TIMEOUT_MS = 30_000
const OBSERVE_MS = 45_000
const SAMPLE_MS = 3000
const QUIT_TIMEOUT_MS = 60_000

function output(result: BoundedResult): string {
	return `${result.timedOut ? "timed out" : `exit ${String(result.status)}`} ${result.stdout.trim()} ${result.stderr.trim()}`.trim()
}

// `security` with arguments that may hold the keychain's password: logged as `display`.
async function security(args: readonly string[], display?: string): Promise<BoundedResult> {
	return runBounded("security", args, TOOL_TIMEOUT_MS, display === undefined ? {} : { display: `security ${display}` })
}

async function mustSecurity(args: readonly string[], display?: string): Promise<string> {
	const result = await security(args, display)

	if (result.status !== 0) {
		fail(`security ${display ?? args.join(" ")}: ${output(result)}`)
	}

	return result.stdout.trim()
}

// The keychain paths `security` prints, one quoted path per line.
function keychainPaths(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim().replace(/^"|"$/g, ""))
		.filter(line => line !== "")
}

async function securityAgent(): Promise<boolean> {
	return (await runBounded("pgrep", ["-x", "SecurityAgent"], TOOL_TIMEOUT_MS)).status === 0
}

export async function runKeyringMac({ target, nextDir, nextVersion, signed, work, artifacts }: SpikeOptions): Promise<void> {
	if (target.platform !== "mac") {
		fail("the keyring-mac spike runs on macOS only")
	}

	if (!signed) {
		fail("the keyring-mac spike needs a Developer-ID-signed build (dispatch with signed: true or profile: nightly)")
	}

	const seed = keyringSeed()
	const password = randomBytes(18).toString("hex")
	const redacted = [...seedRedacted(seed), password]
	const findings = createFindings("spike-keyring-mac", artifacts, text => redactor(redacted)(text))
	const block = offlineBlockFor(target)
	const keychain = path.join(work, "filen-e2e-keyring.keychain-db")
	const mainLog = path.join(target.userData, "logs", "main.log")
	const appOutput = path.join(work, "keyring-mac-app-output.log")
	const marker = () => readJson(path.join(target.userData, "migration.json"))
	// Set as the run gets there; the cleanup acts on them.
	const reached: { before?: { default: string; list: string[] }; created?: boolean; launched?: Launched } = {}

	mask(redacted)
	mkdirSync(work, { recursive: true })

	// One N launch observed for `ms`: SecurityAgent, main.log's keychain lines since `offset`, the marker; a screenshot
	// when the prompt first shows and at the end.
	const observe = async (label: string, offset: number, ms: number): Promise<void> => {
		const timeline: string[] = []
		const start = Date.now()
		let shot = false
		let last = ""

		while (Date.now() - start < ms) {
			const prompt = await securityAgent()
			const log = existsSync(mainLog) ? readFileSync(mainLog).subarray(offset).toString("utf8") : ""
			const now = `SecurityAgent ${prompt ? "running" : "not running"}; ${cipherSeen(log)}; marker ${JSON.stringify(marker())}`

			if (now !== last) {
				timeline.push(`+${String(Math.round((Date.now() - start) / 1000))} s ${now}`)
				last = now
			}

			if (prompt && !shot) {
				shot = true
				await macOs.screenDump(path.join(artifacts, `keyring-mac-${label}-prompt.png`))
			}

			await sleep(SAMPLE_MS)
		}

		const log = existsSync(mainLog) ? readFileSync(mainLog).subarray(offset).toString("utf8") : ""

		await macOs.screenDump(path.join(artifacts, `keyring-mac-${label}-end.png`))
		findings.info(`${label}: timeline`, timeline.join(" | "))
		findings.info(`${label}: main.log keychain lines`, keychainLines(log).join(" | ") || "nothing logged")
	}

	const logSize = () => (existsSync(mainLog) ? statSync(mainLog).size : 0)

	const launchN = async (): Promise<Launched> => {
		reached.launched = await launchDebuggable(target, false, appOutput, block.via ?? undefined)

		return reached.launched
	}

	const quitN = async (): Promise<void> => {
		await macOs.requestQuit(target.mainProcesses().map(item => item.pid))

		const deadline = Date.now() + QUIT_TIMEOUT_MS

		while (target.mainProcesses().length > 0 && Date.now() < deadline) {
			await sleep(1000)
		}

		if (target.mainProcesses().length > 0) {
			await macOs.forceKill(target.mainProcesses().map(item => item.pid))
			findings.info("N quit", "still running a minute after SIGTERM: killed")
		}

		delete reached.launched
	}

	const drive = async (): Promise<void> => {
		await findings.must(
			"every launch behind the offline block",
			async () => `${await block.prepare()}; ${await block.block(target, [])}`
		)

		await findings.must("a dedicated keychain with a random password, the default before 3.0.53 runs", async () => {
			reached.before = {
				default: keychainPaths(await mustSecurity(["default-keychain", "-d", "user"]))[0] ?? "",
				list: keychainPaths(await mustSecurity(["list-keychains", "-d", "user"]))
			}
			rmSync(keychain, { force: true })
			await mustSecurity(["create-keychain", "-p", password, keychain], `create-keychain -p <redacted> ${keychain}`)
			reached.created = true
			// No timeout, no lock on sleep: it locks only when this spike locks it.
			await mustSecurity(["set-keychain-settings", keychain])
			await mustSecurity(["list-keychains", "-d", "user", "-s", keychain, ...reached.before.list])
			await mustSecurity(["default-keychain", "-d", "user", "-s", keychain])
			await mustSecurity(["unlock-keychain", "-p", password, keychain], `unlock-keychain -p <redacted> ${keychain}`)

			return `${keychain} first in the search list and the default (was ${reached.before.default})`
		})

		await findings.must(`${LEGACY_VERSION} installed and given the synthetic signed-in profile`, async () => {
			installFrom(target, await legacyInstaller(target, work), LEGACY_VERSION, true)

			const launched = await launchDebuggable(target, true, appOutput, block.via ?? undefined)

			try {
				const renderer = await connectRenderer(launched.debugPort, LEGACY_ORIGIN, START_TIMEOUT_MS)

				try {
					await seedKeyringLegacy(renderer.page, seed, START_TIMEOUT_MS)
				} finally {
					await renderer.browser.close().catch(() => undefined)
				}
			} finally {
				await quitLegacy(launched, QUIT_TIMEOUT_MS).catch(async (error: unknown) => {
					await macOs.forceKill(target.mainProcesses().map(item => item.pid))

					throw error
				})
			}

			return "seeded and quit"
		})
		findings.info(
			`"Filen Safe Storage" in the keychain after ${LEGACY_VERSION}`,
			output(await security(["find-generic-password", "-s", "Filen Safe Storage", keychain]))
		)

		await findings.must("N installed over it (no updater)", () => {
			// The disk image is copied over the old bundle as a whole, as a user replacing the app does.
			rmSync(path.resolve(target.executable, "..", "..", ".."), { recursive: true, force: true })
			target.install(path.join(nextDir, target.installer))
			target.verifyInstall(true)

			return `${target.installedVersion()} (expected ${nextVersion})`
		})

		await findings.must("the keychain locked before N's first launch", async () => {
			await mustSecurity(["lock-keychain", keychain])

			return output(await security(["show-keychain-info", keychain]))
		})

		const first = logSize()

		await launchN()
		await observe("locked", first, OBSERVE_MS)

		await findings.must("the prompt cancelled (SecurityAgent killed)", async () => {
			const running = await securityAgent()

			return `${running ? "was running" : "was not running"}; killall: ${output(await runBounded("killall", ["SecurityAgent"], TOOL_TIMEOUT_MS))}`
		})
		await observe("cancelled", first, OBSERVE_MS / 2)

		await findings.must("the keychain unlocked from outside, N still running", async () => {
			await mustSecurity(["unlock-keychain", "-p", password, keychain], `unlock-keychain -p <redacted> ${keychain}`)

			return `${String(target.mainProcesses().length)} main process(es) running`
		})
		await observe("unlocked-while-running", first, OBSERVE_MS / 2)
		await quitN()

		const second = logSize()

		await launchN()
		await observe("relaunched-unlocked", second, OBSERVE_MS)
		await quitN()
		findings.info(
			'"Filen Safe Storage" in the keychain at the end',
			output(await security(["find-generic-password", "-s", "Filen Safe Storage", keychain]))
		)
	}

	try {
		await drive()
	} catch (error) {
		await findings.check("the spike ran to the end", () => fail(errorMessage(error)))
	} finally {
		findings.attach("keyring-mac-main.log", existsSync(mainLog) ? readFileSync(mainLog, "utf8").slice(-200_000) : "(none)")
		findings.attach("keyring-mac-output.log", existsSync(appOutput) ? readFileSync(appOutput, "utf8").slice(-200_000) : "(none)")

		for (const cleanup of [
			// A prompt left up would cover the next job's screen on a reused runner.
			() => runBounded("killall", ["SecurityAgent"], TOOL_TIMEOUT_MS),
			async () => (reached.launched === undefined ? undefined : quitN()),
			async () => {
				if (reached.before !== undefined) {
					await security(["list-keychains", "-d", "user", "-s", ...reached.before.list])

					if (reached.before.default !== "") {
						await security(["default-keychain", "-d", "user", "-s", reached.before.default])
					}
				}
			},
			async () => (reached.created === true ? security(["delete-keychain", keychain]) : undefined),
			() => block.lift(),
			() => target.reset()
		]) {
			try {
				await cleanup()
			} catch (error) {
				console.log(`cleanup: ${errorMessage(error)}`)
			}
		}
	}

	findings.finish()
}
