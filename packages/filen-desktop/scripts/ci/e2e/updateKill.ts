import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { hashFile } from "../../feed.ts"
import { errorMessage, fail, holds, runBounded, section, serveFeed, startXvfb, waitFor, type FeedServer } from "../support.ts"
import type { Arch, Format, Platform, Target } from "../targets.ts"
import { createFindings, type Findings } from "./findings.ts"
import {
	feedFor,
	installFrom,
	MARKER,
	processesAt,
	sameVersion,
	START_TIMEOUT_MS,
	tail,
	TEST_FEED_ENV,
	TEST_FEED_LOG,
	writeMarker
} from "./update.ts"
import { installerProcesses, logMark, logSince } from "./updateFaults.ts"

// Scenario update-kill (release and by hand; install depth, nothing signed in): N-1 updates to N from the loopback
// feed, and its installer is killed mid-install. What a user is then left with must work:
//
//   Windows   the NSIS installer killed while $INSTDIR\Filen.exe is missing (the old files removed, the new ones not
//             unpacked yet): a manual reinstall of N recovers, and the app data (the marker) survives
//   macOS     ShipIt killed (pkill -9) once N-1 quit for it: the app is N or N-1, passes codesign --verify --deep
//             --strict and launches
//   deb       dpkg killed mid-unpack: N-1 keeps running; once it quits, its updater installs N on the way out (ii N)
//   AppImage  mv failing (a PATH shim that exits 1): the running AppImage is never deleted (F4)
//
//   node scripts/ci/e2e.ts --scenario update-kill ... (see e2e.ts)

const INSTALL_WAIT_MS = 15 * 60 * 1000
const ALIVE_MS = 20 * 1000
const TOOL_TIMEOUT_MS = 60_000
// How long ShipIt must stay gone before the app it left is judged (launchd may restart a killed ShipIt).
const SHIPIT_QUIET_MS = 15 * 1000
const SHIPIT_WAIT_MS = 5 * 60 * 1000
// dpkg -i of the whole package, run by the updater on the app's way out.
const DPKG_WAIT_MS = 5 * 60 * 1000

export interface UpdateKillOptions {
	target: Target
	platform: Platform
	arch: Arch
	format: Format
	nextDir: string
	nextVersion: string
	prevDir: string
	prevVersion: string
	signed: boolean
	work: string
	artifacts: string
}

interface Running {
	target: Target
	findings: Findings
	pids: number[]
	mark: ReturnType<typeof logMark>
	options: UpdateKillOptions
	token: string
}

// Whether every one of `pids` has exited: a signal-0 probe, cheap enough for the tight polls here.
function gone(pids: readonly number[]): boolean {
	return pids.every(pid => {
		try {
			process.kill(pid, 0)

			return false
		} catch (error) {
			return !(error instanceof Error && "code" in error && error.code === "EPERM")
		}
	})
}

function markerKept(target: Target, token: string): string {
	const marker = path.join(target.userData, MARKER)

	if (!existsSync(marker) || readFileSync(marker, "utf8") !== token) {
		fail(`${marker} did not survive: userData was removed or replaced`)
	}

	return "marker intact"
}

// The installed app launched against an empty feed (so it never updates itself here): it must log `version` starting
// and keep running, and is killed after.
async function launchesAs(target: Target, version: string, work: string): Promise<string> {
	const quiet = await serveFeed(work, [])
	const mark = logMark(target)

	try {
		target.launch({ ...process.env, [TEST_FEED_ENV]: quiet.url })
		await waitFor(`${version} to start`, START_TIMEOUT_MS, () =>
			logSince(target, mark).includes(` INFO Filen ${version} starting (`) ? true : null
		)

		const pids = (
			await waitFor(`${version}'s main process`, START_TIMEOUT_MS, () => {
				const found = processesAt(target)

				return found.length > 0 ? found : null
			})
		).map(found => found.pid)

		await holds(`${version} running from ${target.executable}`, ALIVE_MS, () => !gone(pids))
		target.kill(pids)

		return `${version} launches and keeps running`
	} finally {
		await quiet.close()
	}
}

async function killWindowsInstaller({ target, findings, options, token }: Running): Promise<void> {
	await findings.check("update-kill: the NSIS installer killed while Filen.exe is missing", async () => {
		// The old uninstaller (run by the new installer) removes the old files before the new ones are unpacked.
		await waitFor("the installer to remove Filen.exe", INSTALL_WAIT_MS, () => (existsSync(target.executable) ? null : true), 25)

		const killed = spawnSync("taskkill.exe", ["/F", "/T", "/IM", target.updateFile], { encoding: "utf8", timeout: 30_000 })

		if (killed.status !== 0) {
			fail(`taskkill ${target.updateFile}: ${`${killed.stdout}${killed.stderr}`.trim() || String(killed.status)}`)
		}

		return `killed ${target.updateFile}; Filen.exe ${existsSync(target.executable) ? "back already" : "still missing"}, uninstall entry ${target.registeredVersion() ?? "gone"}`
	})
	await findings.check("update-kill: a manual reinstall of N recovers the install and keeps the app data", async () => {
		target.kill(target.mainProcesses().map(found => found.pid))
		// Over what the killed installer left (installFrom would reset the machine first).
		target.install(path.join(options.nextDir, target.installer))
		target.verifyInstall(options.signed)

		const installed = target.installedVersion()
		const registered = target.registeredVersion()

		if (!sameVersion(installed, options.nextVersion) || registered === null || !sameVersion(registered, options.nextVersion)) {
			fail(
				`after the reinstall the app is ${installed} and the uninstall entry ${registered ?? "missing"}, expected ${options.nextVersion}`
			)
		}

		markerKept(target, token)

		return `${options.nextVersion} reinstalled over the broken install, marker intact; ${await launchesAs(target, options.nextVersion, options.work)}`
	})
}

function shipIt(): number[] {
	const found = spawnSync("pgrep", ["-x", "ShipIt"], { encoding: "utf8", timeout: 10_000 })

	return found.stdout
		.split("\n")
		.map(Number)
		.filter(pid => pid > 0)
}

async function killShipIt({ target, findings, options, pids, token }: Running): Promise<void> {
	await findings.check("update-kill: ShipIt killed once N-1 quit for it", async () => {
		const running = await waitFor(
			"ShipIt to run with N-1 gone",
			INSTALL_WAIT_MS,
			() => {
				const found = shipIt()

				return found.length > 0 && gone(pids) ? found : null
			},
			200
		)

		spawnSync("pkill", ["-9", "-x", "ShipIt"], { encoding: "utf8", timeout: 10_000 })

		return `killed ShipIt ${running.join(", ")}`
	})

	let quietSince: number | null = null

	await waitFor("ShipIt to stay gone", SHIPIT_WAIT_MS, () => {
		if (shipIt().length > 0) {
			quietSince = null

			return null
		}

		quietSince ??= Date.now()

		return Date.now() - quietSince >= SHIPIT_QUIET_MS ? true : null
	}).catch((error: unknown) => findings.info("ShipIt after the kill", errorMessage(error)))

	await findings.check("update-kill: the app ShipIt left is N or N-1, validly signed and launchable", async () => {
		const app = path.resolve(target.executable, "..", "..", "..")

		if (!existsSync(target.executable)) {
			fail(`${target.executable} is missing`)
		}

		const version = target.installedVersion()

		if (!sameVersion(version, options.nextVersion) && !sameVersion(version, options.prevVersion)) {
			fail(`the installed app is ${version}, neither ${options.nextVersion} nor ${options.prevVersion}`)
		}

		const codesign = await runBounded("codesign", ["--verify", "--deep", "--strict", app], 3 * 60 * 1000)

		if (codesign.timedOut || codesign.status !== 0) {
			fail(`codesign --verify --deep --strict: ${codesign.timedOut ? "timed out" : codesign.stderr.trim()}`)
		}

		// A ShipIt that launchd restarted may have finished and relaunched the app.
		target.kill(target.mainProcesses().map(found => found.pid))
		markerKept(target, token)

		return `${version}, codesign valid, marker intact; ${await launchesAs(target, version, options.work)}`
	})
}

// dpkg processes (root's, so by /proc rather than by signal).
function dpkgPids(): number[] {
	return readdirSync("/proc")
		.filter(entry => /^\d+$/.test(entry))
		.filter(pid => {
			try {
				return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "dpkg"
			} catch {
				return false
			}
		})
		.map(Number)
}

// dpkg unpacks every file beside its final name as <name>.dpkg-new and renames them all once the archive is out.
function unpacking(): boolean {
	try {
		return readdirSync("/opt/Filen").some(name => name.endsWith(".dpkg-new"))
	} catch {
		return false
	}
}

async function killDpkg({ target, findings, options, pids, token }: Running): Promise<void> {
	const killed = await findings.check("update-kill: dpkg killed mid-unpack", async () => {
		await waitFor("dpkg to unpack the update", INSTALL_WAIT_MS, () => (unpacking() ? true : null), 20)

		const dpkg = dpkgPids()

		target.kill(dpkg)

		if (dpkg.length === 0) {
			fail("no dpkg process to kill")
		}

		return `killed dpkg ${dpkg.join(", ")}`
	})

	if (!killed) {
		return
	}

	const afterKill = logMark(target)

	await findings.check("update-kill: N-1 keeps running after its install failed", async () => {
		// The updater follows a failed dpkg with apt-get install -f, which cannot finish a package it has no archive for;
		// both run inside the app's main process, so its error is the end of the attempt.
		await waitFor("the updater to report the failed install", INSTALL_WAIT_MS, () =>
			logSince(target, afterKill).includes("updater: Error: ") || gone(pids) ? true : null
		)
		await holds(`${options.prevVersion} running`, ALIVE_MS, () => !gone(pids))

		const status = await runBounded("dpkg-query", ["-W", "-f", "${db:Status-Abbrev}${Version}", "filen"], TOOL_TIMEOUT_MS)

		return `${options.prevVersion} still running (pid ${pids.join(", ")}); dpkg records filen as "${status.stdout.trim()}"`
	})
	await findings.check("update-kill: once N-1 quits, its updater installs N (dpkg: ii N)", async () => {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM")
			} catch {
				// Already gone.
			}
		}

		// The updater runs dpkg -i on the app's way out.
		await waitFor(`${options.prevVersion} to quit`, DPKG_WAIT_MS, () => (gone(pids) ? true : null))

		const registered = await waitFor("dpkg to record N installed", DPKG_WAIT_MS, () => {
			const version = target.registeredVersion()

			return version !== null && sameVersion(version, options.nextVersion) ? version : null
		})
		const installed = target.installedVersion()

		if (!sameVersion(installed, options.nextVersion)) {
			fail(`the installed app is ${installed}, expected ${options.nextVersion}`)
		}

		markerKept(target, token)

		return `ii ${registered}, app ${installed}, marker intact`
	})
}

async function failMv({ target, findings, options, pids, mark }: Running, original: string): Promise<void> {
	await findings.check("update-kill: a failed mv leaves the running AppImage in place (F4)", async () => {
		await waitFor("the updater's mv to fail", INSTALL_WAIT_MS, () => {
			const text = logSince(target, mark)

			return text.includes("Command failed: mv") || gone(pids) ? true : null
		})

		if (!existsSync(target.executable)) {
			fail(`${target.executable} is gone`)
		}

		if ((await hashFile(target.executable))?.sha512 !== original) {
			fail(`${target.executable} is no longer the installed ${options.prevVersion}`)
		}

		const staged = path.join(path.dirname(target.executable), `.${path.basename(target.executable)}.update`)

		if (existsSync(staged)) {
			fail(`${staged} was left behind`)
		}

		await holds(`${options.prevVersion} running`, ALIVE_MS, () => !gone(pids))

		return `${target.executable} intact (${options.prevVersion}), nothing staged beside it, ${options.prevVersion} still running`
	})
}

export async function runUpdateKill(options: UpdateKillOptions): Promise<void> {
	const { target, platform, format, nextDir, nextVersion, prevDir, prevVersion, signed, work, artifacts } = options

	if (platform === "mac" && !signed) {
		console.log("::notice::update-kill skipped on macOS: Squirrel.Mac needs both builds signed by the same Developer ID")

		return
	}

	if (format === "rpm") {
		fail("update-kill has no rpm case")
	}

	const findings = createFindings("update-kill", artifacts)

	mkdirSync(work, { recursive: true })

	const xvfb = platform === "linux" ? await startXvfb() : null
	// AppImage: an mv that always fails, first on the app's PATH.
	const shim = format === "AppImage" ? mkdtempSync(path.join(work, "mv-shim-")) : null
	let feed: FeedServer | null = null

	try {
		installFrom(target, path.join(prevDir, target.installer), prevVersion, signed)

		const token = writeMarker(target)
		const original = format === "AppImage" ? ((await hashFile(target.executable))?.sha512 ?? fail("no AppImage installed")) : ""

		if (shim !== null) {
			writeFileSync(path.join(shim, "mv"), '#!/bin/sh\necho "e2e: mv refused" >&2\nexit 1\n')
			chmodSync(path.join(shim, "mv"), 0o755)
		}

		feed = (await feedFor(target, nextDir, nextVersion)).server

		section(`update-kill: ${prevVersion} -> ${nextVersion}, its installer killed`)

		const mark = logMark(target)

		target.launch({
			...process.env,
			[TEST_FEED_ENV]: feed.url,
			...(shim === null ? {} : { PATH: `${shim}${path.delimiter}${process.env["PATH"] ?? ""}` })
		})
		await waitFor(`${prevVersion} to start and take the test feed`, START_TIMEOUT_MS, () => {
			const text = logSince(target, mark)

			return text.includes(` INFO Filen ${prevVersion} starting (`) && text.includes(TEST_FEED_LOG) ? true : null
		})

		const pids = (
			await waitFor(`${prevVersion}'s main process`, START_TIMEOUT_MS, () => {
				const found = processesAt(target)

				return found.length > 0 ? found : null
			})
		).map(found => found.pid)
		const running: Running = { target, findings, pids, mark, options, token }

		switch (format) {
			case "nsis":
				await killWindowsInstaller(running)
				break
			case "dmg":
				await killShipIt(running)
				break
			case "deb":
				await killDpkg(running)
				break
			case "AppImage":
				await failMv(running, original)
				break
		}
	} catch (error) {
		await findings.check("the update-kill scenario ran", () => fail(errorMessage(error)))
	} finally {
		const mainLog = path.join(target.userData, "logs", "main.log")

		findings.attach("update-kill-main.log", tail(mainLog, 400))
		findings.attach(
			"update-kill-feed.txt",
			feed?.requests.map(request => `${String(request.status)} ${request.path} ${String(request.bytes)}`).join("\n") ?? "(no feed)"
		)

		try {
			findings.info("installer processes left", (await installerProcesses(target)).join("; ") || "none")
		} catch (error) {
			findings.info("installer processes left", errorMessage(error))
		}

		// A package dpkg left half-installed is not "ii", which reset() purges; it goes here.
		if (format === "deb") {
			await runBounded("sudo", ["--non-interactive", "dpkg", "--purge", "--force-all", "filen"], 5 * 60 * 1000)
		}

		try {
			target.reset()
		} catch (error) {
			console.log(`cleanup: ${errorMessage(error)}`)
		}

		await feed?.close()
		xvfb?.kill()

		if (shim !== null) {
			rmSync(shim, { recursive: true, force: true })
		}
	}

	findings.finish()
}
