import { randomBytes } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DesktopLockStatus, DesktopPrefs } from "@filen/shared/desktop"
import { LEGACY_KEYS } from "../../../../src/main/legacyData.ts"
import { LEGACY_VERSION } from "../../legacy.ts"
import { errorMessage, fail, startXvfb, waitFor } from "../../support.ts"
import { detached, type Target } from "../../targets.ts"
import { APP_ORIGIN, desktop, sessionStatus, unlockThroughScreen } from "../app.ts"
import { listTargets } from "../cdp/inspector.ts"
import { connectRenderer, type Renderer } from "../cdp/renderer.ts"
import { createFindings } from "../findings.ts"
import {
	backdateImport,
	cipherSeen,
	type CipherSeen,
	fallbackKeyFiles,
	heldProblems,
	keychainLines,
	keyringEncrypted,
	keyringSeed,
	type MarkerRead,
	readLegacyOrigin,
	seedKeyringLegacy,
	seedRedacted,
	seedSecrets
} from "../keyringData.ts"
import { exitWithin, launchDebuggable, type Launched } from "../launch.ts"
import { LEGACY_ORIGIN, quitLegacy } from "../legacyApp.ts"
import { secretService, type KeyringStore, type SecretService, type SecretServiceMode } from "../linux.ts"
import { offlineBlockFor } from "../offlineBlock.ts"
import { osFor } from "../os.ts"
import { redactor } from "../redact.ts"
import { mask } from "../session.ts"
import { filesHolding } from "../snapshot.ts"
import { installFrom, legacyInstaller, sameVersion, START_TIMEOUT_MS, tail } from "../update.ts"
import { EXIT_TIMEOUT_MS, inventory, json, readJson, SETUP_TIMEOUT_MS } from "./common.ts"

// Chain K (gap 2, proving fix B1 in src/main/migration.ts, sessionVault.ts and appLock.ts): the 3.x import when the
// keyring is missing, locked or comes back, on Linux deb with no sign-in at all. 3.0.53 is installed and given a
// synthetic signed-in profile (scripts/ci/e2e/keyringData.ts: random keys and userIds, a PIN with its timeout, both
// window prefs on, sync, drive and WebDAV settings of a second user); N is then installed over it as a package
// upgrade (no updater: chain L covers that) and that profile copied aside (k-base). Every launch of N runs behind the
// offline block (its group's packets off the loopback interface are rejected), so the fake key never reaches the API,
// and on a Secret Service of its own (linux.ts secretService): none, the login keyring locked with no prompt
// possible (a dismissed prompt), or unlocked.
//
// Without a working keyring, Electron's safeStorage on Linux encrypts with Chromium's hardcoded fallback key ("v10") and
// still reports the keyring's backend; N takes that probe as no secure storage (src/main/index.ts sessionCipher), so
// such a launch is in memory (or deferred, where safeStorage rejects), never "encrypted", and stores nothing with v10.
//
// The assertion table (each one a finding):
//   K1   no Secret Service        the import waits instead of failing: stage started, failedStarts 0, prefs imported,
//                                 in memory (volatileStash) or deferred as safeStorage reported it, nothing stored
//                                 with the fallback key (v10); the prefs verbatim
//                                 (and N starts hidden); the app lock as that path leaves it (the PIN locks and
//                                 unlocks, or waits with the session), never stuck; nothing wiped (the old origin still
//                                 holds its account and PIN, read through CDP on filendesktop://bundle; the old logs
//                                 kept); no seeded secret in any userData file outside Local Storage and IndexedDB
//   K2   keyring unlocked         the import completes for the seeded account; migration.stash and lock.vault start
//                                 with v11 (and session.vault, where there is one); the service lists "Filen Safe
//                                 Storage"; N starts locked and the PIN unlocks it (the lock is not stuck)
//   K3   the 7-day wait ran out   importedAt backdated 8 days: verified, wiped and logsDeleted; the old logs gone; the
//                                 old origin's secrets gone, read through CDP on filendesktop://bundle
//   KB1-3  k-base, keyring locked  three launches: each one holds the import in memory or defers, uncounted (never
//                                 abandoned, though B1's bug gave up after MAX_FAILED_STARTS), nothing stored with the
//                                 fallback key (v10); the prefs imported
//   KB4  then unlocked            the import completes
//
// What safeStorage did in each launch (no secure storage, a rejected probe, a refused encryption) is recorded as
// information: Electron 45's behaviour without a working keyring is what the K1 spike asked.

const IMPORT_TIMEOUT_MS = 90_000
// How long a launch may show no page before it counts as started hidden (startMinimized) and a second instance shows it.
const HIDDEN_PROBE_MS = 30_000
const SECOND_INSTANCE_MS = 30_000
const WAIT_EXPIRED_MS = 8 * 24 * 60 * 60 * 1000
// MAX_FAILED_STARTS in src/main/migration.ts: as many locked launches as gave up before B1.
const LOCKED_LAUNCHES = 3

export interface KeyringOptions {
	target: Target
	nextDir: string
	nextVersion: string
	work: string
	artifacts: string
}

interface Launch {
	label: string
	launched: Launched
	renderer: Renderer
	hidden: boolean
	// main.log from this launch on.
	log(): string
	seen(): CipherSeen
}

export async function runKeyring({ target, nextDir, nextVersion, work, artifacts }: KeyringOptions): Promise<void> {
	if (target.platform !== "linux" || target.format !== "deb") {
		fail("chain K runs on Linux deb only")
	}

	const seed = keyringSeed()
	const redacted = [...seedRedacted(seed)]
	const findings = createFindings("keyring", artifacts, text => redactor(redacted)(text))
	const block = offlineBlockFor(target)
	const os = osFor(target)
	const userData = (...parts: string[]) => path.join(target.userData, ...parts)
	const marker = () => readJson(userData("migration.json")) as MarkerRead | null
	const mainLog = userData("logs", "main.log")
	const appOutput = path.join(work, "keyring-app-output.log")
	const serviceLog = path.join(work, "keyring-secret-service.log")
	const legacyLogs = path.join(path.dirname(target.userData), "logs")
	const kBase = path.join(work, "k-base")
	const keyring = (name: string): KeyringStore => ({ dir: path.join(work, `keyring-${name}`), password: randomBytes(16).toString("hex") })
	// Branch A's keyring (K2, K3) and branch B's, each its own login keyring.
	const keyringA = keyring("a")
	const keyringB = keyring("b")
	// The launch's Secret Service and the launch itself, while there is one; whether 3.0.53 left its logs directory.
	const state: { service: SecretService | null; current: Launch | null; legacyLogs: boolean } = {
		service: null,
		current: null,
		legacyLogs: false
	}
	const pidsOf = (lines: readonly string[]) => lines.map(line => Number.parseInt(line, 10)).filter(pid => Number.isSafeInteger(pid))

	redacted.push(keyringA.password, keyringB.password)
	mask(redacted)

	const serviceFor = async (mode: SecretServiceMode, store?: KeyringStore): Promise<SecretService> => {
		await state.service?.stop()
		state.service = null
		state.service = await secretService(mode, work, serviceLog, store)

		return state.service
	}

	const logSize = () => (existsSync(mainLog) ? statSync(mainLog).size : 0)

	// N through the offline block on `active`'s bus, connected to its page; a hidden start (startMinimized) gets a second
	// instance, through the same block and bus, which shows the window.
	const launchN = async (label: string, active: SecretService): Promise<Launch> => {
		const offset = logSize()
		const extra = { env: active.env }
		const launched = await launchDebuggable(target, false, appOutput, block.via ?? undefined, extra)
		const shown = await waitFor(
			"a page or a hidden start",
			HIDDEN_PROBE_MS,
			async () => ((await listTargets(launched.debugPort))?.some(item => item.url.startsWith(APP_ORIGIN)) === true ? true : null),
			1000
		).catch(() => false)

		if (!shown) {
			const exit = await exitWithin(launched, 0)

			if (exit !== null) {
				fail(`${label} exited before its page came up: ${json(exit)}`)
			}

			const env = target.launchEnv({ ...process.env, ...active.env })
			const [command, ...prefix] = block.via ?? []
			const second = command === undefined ? target.launch(env) : detached(command, [...prefix, target.executable], env)

			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, SECOND_INSTANCE_MS)

				second.once("exit", () => {
					clearTimeout(timer)
					resolve()
				})
			})
		}

		const log = () => (existsSync(mainLog) ? readFileSync(mainLog).subarray(offset).toString("utf8") : "")
		const launch: Launch = {
			label,
			launched,
			renderer: await connectRenderer(launched.debugPort, APP_ORIGIN, START_TIMEOUT_MS),
			hidden: !shown,
			log,
			seen: () => cipherSeen(log())
		}

		state.current = launch

		return launch
	}

	// SIGTERM to N's main process, then every process of the install gone (helpers too) before its bus goes.
	const quitN = async (launch: Launch): Promise<void> => {
		await launch.renderer.browser.close().catch(() => undefined)
		state.current = null
		findings.attach(`keyring-${launch.label}-main.log`, launch.log())
		await os.requestQuit(target.mainProcesses().map(item => item.pid))

		const gone = async () => ((await os.appProcesses(target)).length === 0 ? true : null)

		await waitFor(`${launch.label} to exit`, EXIT_TIMEOUT_MS, gone, 1000).catch(async (error: unknown) => {
			const left = await os.appProcesses(target)

			await os.forceKill(pidsOf(left))
			fail(`${errorMessage(error)}: ${left.join("; ")}`)
		})
	}

	// What safeStorage did, as information, with the launch's keychain lines.
	const recordCipher = (launch: Launch, what: string) => {
		findings.info(
			`${launch.label} safeStorage ${what}`,
			`${launch.seen()}: ${keychainLines(launch.log()).join(" | ") || "nothing logged"}`
		)
	}

	const lockStatus = (launch: Launch) => desktop<DesktopLockStatus>(launch.renderer.page, "window.desktop.lock.status()")

	// N started locked and `pin` unlocks it through the lock screen.
	const unlocks = async (launch: Launch): Promise<string> => {
		const status = await lockStatus(launch)

		if (!status.enabled || !status.locked || status.unreadable) {
			fail(`not locked with a readable PIN at start: ${json(status)}`)
		}

		await unlockThroughScreen(launch.renderer.page, seed.pin, START_TIMEOUT_MS)
		await waitFor("the unlock", SETUP_TIMEOUT_MS, async () => ((await lockStatus(launch)).locked ? null : true))

		return "locked at start; the 3.x PIN unlocks it through the lock screen"
	}

	const prefsImported = async (launch: Launch): Promise<string> => {
		const prefs = await desktop<DesktopPrefs>(launch.renderer.page, "window.desktop.prefs.get()")

		if (!prefs.minimizeToTray || !prefs.startMinimized || !launch.hidden) {
			fail(
				`${json({ minimizeToTray: prefs.minimizeToTray, startMinimized: prefs.startMinimized })}; hidden start ${String(launch.hidden)}`
			)
		}

		return "minimizeToTray and startMinimized on, as 3.x had them; N started hidden"
	}

	// The marker once this launch's import attempt ended (the page shows only after migration.start settled).
	const held = (launch: Launch): string => {
		const read = marker()
		const problems = heldProblems(read, launch.seen())

		if (problems.length > 0) {
			fail(`${problems.join("; ")}; marker ${json(read)}`)
		}

		return `${launch.seen() === "memory" ? "in memory (volatileStash), read again next launch" : "deferred"}; failedStarts 0; prefs imported; stage started`
	}

	// Nothing stored with the fallback key this launch: it protects nothing.
	const noFallbackKey = (): string => {
		const files = fallbackKeyFiles(target.userData)

		if (files.length > 0) {
			fail(`encrypted with the fallback key (v10): ${files.join(", ")}`)
		}

		return `no v10 file; ${["session.vault", "lock.vault", "migration.stash"].map(name => `${name} ${existsSync(userData(name)) ? "present" : "absent"}`).join(", ")}`
	}

	const imported = (): string => {
		const read = marker()

		if (
			read?.stage !== "imported" ||
			read.userId !== Number(seed.client.userId) ||
			read.volatileStash === true ||
			read.deferred === true
		) {
			fail(`marker ${json(read)}`)
		}

		return "stage imported for the seeded account"
	}

	// The old origin's page, read through CDP: N's window navigated there (a browser-initiated navigation, which no
	// navigation guard sees) once main has served that origin in this launch. N is quit afterwards.
	const legacyOrigin = async (launch: Launch) => {
		await launch.renderer.page.goto(`${LEGACY_ORIGIN}/`, { timeout: 30_000 })

		return readLegacyOrigin(launch.renderer.page, seedSecrets(seed))
	}

	const setUp = async (): Promise<void> => {
		await findings.must(
			"every launch behind the offline block",
			async () => `${await block.prepare()}; ${await block.block(target, [])}`
		)

		await findings.must(`${LEGACY_VERSION} installed and given the synthetic signed-in profile`, async () => {
			installFrom(target, await legacyInstaller(target, work), LEGACY_VERSION, false)

			const active = await serviceFor("none")
			const launched = await launchDebuggable(target, true, appOutput, block.via ?? undefined, { env: active.env })
			let written: string[]

			try {
				const renderer = await connectRenderer(launched.debugPort, LEGACY_ORIGIN, START_TIMEOUT_MS)

				try {
					written = await seedKeyringLegacy(renderer.page, seed, START_TIMEOUT_MS)
				} finally {
					await renderer.browser.close().catch(() => undefined)
				}
			} finally {
				// app.quit() flushes its localStorage to disk.
				await quitLegacy(launched, EXIT_TIMEOUT_MS).catch(async (error: unknown) => {
					await os.forceKill(pidsOf(await os.appProcesses(target)))

					throw error
				})
			}

			await waitFor("the old app's processes to end", EXIT_TIMEOUT_MS, async () =>
				(await os.appProcesses(target)).length === 0 ? true : null
			)

			if (!existsSync(userData("IndexedDB", "filendesktop_bundle_0.indexeddb.leveldb")) || !existsSync(userData("Local Storage"))) {
				fail("the old origin left no IndexedDB or Local Storage")
			}

			state.legacyLogs = existsSync(legacyLogs)

			return `wrote ${written.join(", ")} (the other user's settings beside the account's); @filen/logs ${state.legacyLogs ? "written" : "not written"}`
		})

		await findings.must("N installed over it as a package upgrade (no updater), the profile kept aside", () => {
			target.install(path.join(nextDir, target.installer))
			target.verifyInstall(false)

			const installed = target.installedVersion()

			if (!sameVersion(installed, nextVersion)) {
				fail(`the installed app is ${installed}, expected ${nextVersion}`)
			}

			rmSync(kBase, { recursive: true, force: true })
			cpSync(target.userData, kBase, { recursive: true, verbatimSymlinks: true })
			findings.attach("keyring-k-base.txt", inventory(kBase))

			return `${installed}; userData copied to k-base`
		})
	}

	const branchA = async (): Promise<void> => {
		const k1 = await launchN("K1", await serviceFor("none"))

		recordCipher(k1, "without a Secret Service")

		const k1Seen = k1.seen()

		await findings.check("K1 no Secret Service: the import waits, uncounted, nothing abandoned", () => held(k1))
		await findings.check("K1 nothing stored with the fallback key (v10)", noFallbackKey)
		await findings.check("K1 prefs imported verbatim", () => prefsImported(k1))
		await findings.check("K1 the app lock as the import left it, never stuck", async () => {
			// In memory the PIN is imported with the session (as a plain record); a deferral leaves both for later.
			if (k1Seen === "memory") {
				return unlocks(k1)
			}

			const status = await lockStatus(k1)

			if (status.enabled || status.locked) {
				fail(`deferred, yet ${json(status)}`)
			}

			return "deferred with the session: no PIN yet, nothing locked"
		})
		await findings.check("K1 nothing wiped early: the old origin keeps its account and PIN, the old logs kept", async () => {
			const read = await legacyOrigin(k1)
			const missing = [LEGACY_KEYS.sdkConfig, LEGACY_KEYS.lockPin].filter(key => !read.present.includes(key))

			if (
				marker()?.wiped !== false ||
				missing.length > 0 ||
				read.holding === 0 ||
				!read.indexedDb ||
				existsSync(legacyLogs) !== state.legacyLogs
			) {
				fail(`wiped ${String(marker()?.wiped)}; ${json(read)}; old logs ${existsSync(legacyLogs) ? "kept" : "gone"}`)
			}

			return `wiped false; the old origin holds ${String(read.present.length)} of the keys, ${String(read.holding)} values with a seeded secret, its IndexedDB; @filen/logs ${state.legacyLogs ? "kept" : "never written"}`
		})
		await quitN(k1)
		await findings.check("K1 no seeded secret in any userData file outside Local Storage and IndexedDB", () => {
			const hits = readdirSync(target.userData)
				.filter(name => name !== "Local Storage" && name !== "IndexedDB")
				.flatMap(name => filesHolding(userData(name), seedSecrets(seed)).map(file => path.join(name, file)))

			if (hits.length > 0) {
				fail(`seeded secrets in ${hits.join(", ")}`)
			}

			return `none in ${readdirSync(target.userData).length - 2} entries; lock.vault ${existsSync(userData("lock.vault")) ? "a plain hash record" : "absent"}`
		})

		const k2 = await launchN("K2", await serviceFor("unlocked", keyringA))

		recordCipher(k2, "with the keyring unlocked")
		await findings.check("K2 keyring unlocked: the import completes", () => imported())
		await findings.check("K2 the stash and the PIN record are encrypted with the keyring's key (v11)", () => {
			const files = ["migration.stash", "lock.vault", ...(existsSync(userData("session.vault")) ? ["session.vault"] : [])]
			const plain = files.filter(name => !keyringEncrypted(existsSync(userData(name)) ? readFileSync(userData(name)) : null))

			if (plain.length > 0) {
				fail(`not v11: ${plain.join(", ")}`)
			}

			return `${files.join(", ")} start with v11`
		})
		await findings.check('K2 the Secret Service holds "Filen Safe Storage"', async () => {
			const items = await (state.service ?? fail("no Secret Service")).items("Filen")

			if (!items.some(line => line === "label = Filen Safe Storage")) {
				fail(`items: ${items.join("; ") || "none"}`)
			}

			return items.join("; ")
		})
		await findings.check("K2 the lock is not stuck: N starts locked and the PIN unlocks it", () => unlocks(k2))
		findings.info(
			"K2 the session after the keyring came back",
			`${await sessionStatus(k2.renderer.page)} (K1 ${k1Seen === "memory" ? "kept the imported session in memory only" : "deferred the session"})`
		)
		await quitN(k2)

		await findings.must("K3 importedAt backdated by 8 days", () => {
			writeFileSync(userData("migration.json"), backdateImport(readFileSync(userData("migration.json"), "utf8"), WAIT_EXPIRED_MS))

			return "migration.json rewritten"
		})

		const k3 = await launchN("K3", await serviceFor("unlocked", keyringA))
		const wiped = await findings.check("K3 the 7-day wait ran out: verified, wiped, the old logs deleted", async () => {
			const read = await waitFor("the wipe", SETUP_TIMEOUT_MS, () => {
				const now = marker()

				return now?.stage === "verified" && now.wiped === true && now.logsDeleted === true ? now : null
			})

			if (existsSync(legacyLogs)) {
				fail(`${legacyLogs} is still there`)
			}

			return `stage ${String(read.stage)}, wiped, logsDeleted; @filen/logs gone`
		})

		if (wiped) {
			await findings.check("K3 the old origin's secrets are gone (read through CDP on filendesktop://bundle)", async () => {
				const read = await legacyOrigin(k3)
				const left = read.present.filter(key => key === LEGACY_KEYS.sdkConfig || key === LEGACY_KEYS.lockPin)

				if (left.length > 0 || read.holding > 0 || read.desktopSdkConfig || read.webdavPasswords > 0 || read.indexedDb) {
					fail(json(read))
				}

				return `no account, PIN or WebDAV password; no value holds a seeded secret; the old IndexedDB deleted (${String(read.present.length)} keys kept)`
			})
		}

		await quitN(k3)
	}

	const branchB = async (): Promise<void> => {
		await findings.must("KB k-base restored (N installed, never launched)", () => {
			rmSync(target.userData, { recursive: true, force: true })
			cpSync(kBase, target.userData, { recursive: true, verbatimSymlinks: true })

			return "userData as before N's first launch"
		})

		for (let index = 1; index <= LOCKED_LAUNCHES; index++) {
			const launch = await launchN(`KB${String(index)}`, await serviceFor("locked", keyringB))

			recordCipher(launch, "with the keyring locked and its prompt dismissed")
			await findings.check(`KB${String(index)} keyring locked, prompt dismissed: the import waits, uncounted, never abandoned`, () =>
				held(launch)
			)
			await findings.check(`KB${String(index)} nothing stored with the fallback key (v10)`, noFallbackKey)
			await findings.check(`KB${String(index)} prefs still imported`, () => prefsImported(launch))
			await quitN(launch)
		}

		const unlocked = await launchN("KB4", await serviceFor("unlocked", keyringB))

		recordCipher(unlocked, "once the keyring is unlocked")
		await findings.check("KB4 after unlocking, the import completes", () =>
			waitFor("the import", IMPORT_TIMEOUT_MS, () => (marker()?.stage === "imported" ? true : null)).then(() => imported())
		)
		await quitN(unlocked)
	}

	mkdirSync(work, { recursive: true })

	const xvfb = await startXvfb()
	let wrapped = false

	// Evidence and cleanup, run once: at the end, or by the budget's watchdog (which then exits) before the step's own
	// timeout kills node and skips them (the offline rule, the detached D-Bus and keyring groups, the reset).
	const wrapUp = async (): Promise<void> => {
		if (wrapped) {
			return
		}

		wrapped = true
		findings.attach("keyring-main.log", tail(mainLog, 1500))
		findings.attach("keyring-output.log", tail(appOutput, 3000))
		findings.attach("keyring-secret-service.log", tail(serviceLog, 400))
		await os.screenDump(path.join(artifacts, "keyring-last-screen.png"))
		await state.current?.renderer.browser.close().catch(() => undefined)
		await os.forceKill(pidsOf(await os.appProcesses(target)))

		for (const cleanup of [
			() => state.service?.stop(),
			() => block.lift(),
			() => target.reset(),
			() => rmSync(kBase, { recursive: true, force: true })
		]) {
			try {
				await cleanup()
			} catch (error) {
				console.log(`cleanup: ${errorMessage(error)}`)
			}
		}

		xvfb?.kill()
	}

	// The chain's whole budget (E2E_CHAIN_BUDGET_MINUTES, below the workflow step's timeout), as in chains P and L.
	const budgetMinutes = Number(process.env["E2E_CHAIN_BUDGET_MINUTES"] ?? "") || 0
	const watchdog =
		budgetMinutes > 0
			? setTimeout(() => {
					void (async () => {
						console.error(`::error::keyring: the chain's ${String(budgetMinutes)}-minute budget ran out`)
						await findings.check(`the chain finished within its ${String(budgetMinutes)}-minute budget`, () =>
							fail("it did not")
						)
						await wrapUp().catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))

						try {
							findings.finish()
						} finally {
							process.exit(1)
						}
					})()
				}, budgetMinutes * 60_000)
			: undefined

	try {
		await setUp()
		await branchA()
		await branchB()
	} catch (error) {
		await findings.check("the chain ran to the end", () => fail(errorMessage(error)))
	} finally {
		clearTimeout(watchdog)
		await wrapUp()
	}

	findings.finish()
}
