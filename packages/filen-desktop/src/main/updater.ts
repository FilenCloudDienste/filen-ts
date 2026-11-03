import type { Logger, UpdateCheckResult, UpdateDownloadedEvent } from "electron-updater"

// The first check waits a little, so it never competes with startup; later ones run on an interval.
export const UPDATE_FIRST_CHECK_DELAY_MS = 15 * 1000
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
// Under the e2e tests' feed, so a failed or stalled attempt is retried within the test.
export const TEST_UPDATE_CHECK_INTERVAL_MS = 30 * 1000
// A check or download that moved no data for this long is cut off. electron-updater's own request timeout never fires
// on Electron's net module, so a stalled connection would otherwise hold every later check back.
export const UPDATE_STALL_MS = 2 * 60 * 1000
// macOS: how long a check waits for Squirrel to take or refuse a download. An answer after that still counts.
export const SQUIRREL_WAIT_MS = 10 * 60 * 1000

export function updateCheckInterval(testFeed: string | null): number {
	return testFeed === null ? UPDATE_CHECK_INTERVAL_MS : TEST_UPDATE_CHECK_INTERVAL_MS
}

export interface UpdateCheckState {
	checking: boolean
	// The version downloaded and waiting for a restart.
	ready: string | null
}

// A check while one runs would race it, and once an update is downloaded nothing newer is fetched until it installs
// (a newer release is picked up by the check after the restart).
export function shouldCheckForUpdate(state: UpdateCheckState): boolean {
	return !state.checking && state.ready === null
}

export interface UpdaterLog {
	info(message: string): void
	warn(message: string): void
}

export interface Updater {
	// The downloaded version waiting for a restart, if any.
	ready(): string | null
	// Starts the downloaded update's installer and quits, relaunching after. False when there is nothing to install. An
	// installer that then fails to start (Windows: a declined elevation; macOS: Squirrel's error) is reported through
	// onInstallFailed, and the app keeps running.
	install(): boolean
}

// What is used of electron-updater's autoUpdater.
export interface UpdaterEngine {
	logger: Logger | null
	autoDownload: boolean
	autoInstallOnAppQuit: boolean
	setFeedURL(options: { provider: "generic"; url: string }): void
	on(event: "error", listener: (error: Error) => void): unknown
	on(event: "checking-for-update" | "update-available" | "download-progress", listener: () => void): unknown
	on(event: "update-downloaded", listener: (event: UpdateDownloadedEvent) => void): unknown
	checkForUpdates(): Promise<Pick<UpdateCheckResult, "downloadPromise"> | null>
	quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

export interface NativeUpdaterEvents {
	downloaded(): void
	error(error: Error): void
}

export interface UpdaterDeps {
	log: UpdaterLog
	testFeed: string | null
	load(): Promise<UpdaterEngine>
	// Terminates the connections of the updater's own session, so a stalled request fails.
	closeConnections(): Promise<void>
	// macOS: subscribes to Squirrel.Mac (Electron's autoUpdater). electron-updater reports a download before Squirrel
	// has fetched and verified it, and only Squirrel installs; null elsewhere.
	native: ((events: NativeUpdaterEvents) => void) | null
	onReady(version: string): void
	// An install that was started did not go ahead: the app keeps running.
	onInstallFailed(): void
}

// A no-progress deadline: every sign of progress pushes it back, and it fires once nothing moved for `ms`.
export interface StallWatch {
	arm(): void
	progress(): void
	disarm(): void
}

export function stallWatch(ms: number, onStall: () => void): StallWatch {
	let timer: ReturnType<typeof setTimeout> | null = null

	return {
		arm: () => {
			if (timer === null) {
				timer = setTimeout(() => {
					timer = null
					onStall()
				}, ms)
			} else {
				timer.refresh()
			}
		},
		progress: () => {
			timer?.refresh()
		},
		disarm: () => {
			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}
		}
	}
}

// The e2e tests (scripts/ci) serve a feed on loopback and point a packaged build at it through
// FILEN_DESKTOP_TEST_UPDATE_FEED. Only an explicit-port http URL on 127.0.0.1 with nothing else in it is taken, so the
// override can never reach a remote feed; signature checks apply to what it serves as to the real feed.
export function testUpdateFeed(value: string | undefined): string | null {
	if (value === undefined) {
		return null
	}

	let url: URL

	try {
		url = new URL(value)
	} catch {
		return null
	}

	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.port === "" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		return null
	}

	return url.href.endsWith("/") ? url.href : `${url.href}/`
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value)
}

// electron-updater's generic provider on the feed electron-builder wrote into app-update.yml; Windows checks the
// installer's signature against the publisher named there. Downloads run in the background and install when the
// user restarts from the page's prompt or on the next quit. The engine loads on first use, so startup never evaluates
// it.
export function startUpdater(deps: UpdaterDeps): Updater {
	const { log, testFeed } = deps
	const state: UpdateCheckState = { checking: false, ready: null }
	// Set with `ready`: a download implies the engine loaded.
	let loaded: UpdaterEngine | null = null
	// macOS: the version electron-updater downloaded and handed to Squirrel, not ready yet.
	let staged: string | null = null
	// macOS: settles once Squirrel took or refused the staged download; the check holds until then, at most
	// SQUIRREL_WAIT_MS.
	let squirrel: PromiseWithResolvers<void> | null = null
	// An install was started and has not failed.
	let installing = false
	const stall = stallWatch(UPDATE_STALL_MS, () => {
		log.warn(`updater: no progress for ${String(UPDATE_STALL_MS / 1000)} s, closing its connections`)
		deps.closeConnections().catch((error: unknown) => {
			log.warn(`updater: connections not closed: ${messageOf(error)}`)
		})
	})
	const updaterLog = {
		info: (message?: unknown) => {
			log.info(`updater: ${messageOf(message)}`)
		},
		warn: (message?: unknown) => {
			log.warn(`updater: ${messageOf(message)}`)
		},
		error: (message?: unknown) => {
			log.warn(`updater: ${messageOf(message)}`)
		}
	}

	function markReady(version: string): void {
		state.ready = version
		deps.onReady(version)
	}

	function installFailed(message: string): void {
		if (!installing) {
			return
		}

		installing = false
		log.warn(`updater: install failed: ${message}`)
		deps.onInstallFailed()
	}

	function settleSquirrel(): void {
		staged = null
		squirrel?.resolve()
		squirrel = null
	}

	const loading = deps.load().then(engine => {
		engine.logger = updaterLog
		engine.autoDownload = true
		engine.autoInstallOnAppQuit = true

		if (testFeed !== null) {
			engine.setFeedURL({ provider: "generic", url: testFeed })
			log.info(`updater: test feed ${testFeed}`)
		}

		engine.on("checking-for-update", stall.progress)
		engine.on("update-available", stall.progress)
		engine.on("download-progress", stall.progress)
		engine.on("update-downloaded", info => {
			// What follows works on the local file (the signature check, Squirrel's fetch) and reports no progress.
			stall.disarm()
			loaded = engine

			if (deps.native === null) {
				markReady(info.version)
			} else {
				staged = info.version
				squirrel ??= Promise.withResolvers()
			}
		})
		// Squirrel's errors arrive here too: electron-updater passes them on. One during a check is the check's.
		engine.on("error", error => {
			if (!state.checking) {
				installFailed(error.message)
			}
		})

		deps.native?.({
			downloaded: () => {
				const version = staged

				settleSquirrel()

				if (version !== null) {
					markReady(version)
				}
			},
			error: error => {
				log.warn(`updater: Squirrel: ${error.message}`)
				settleSquirrel()
				// Nothing installs until a later check hands the download to Squirrel again.
				state.ready = null
				installFailed(error.message)
			}
		})

		return engine
	})

	// Reported by the check that awaits it.
	loading.catch(() => undefined)

	async function squirrelAnswer(): Promise<void> {
		const pending = squirrel

		if (pending === null) {
			return
		}

		let timer: ReturnType<typeof setTimeout> | undefined
		const answered = await Promise.race([
			pending.promise.then(() => true),
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => {
					resolve(false)
				}, SQUIRREL_WAIT_MS)
			})
		])

		clearTimeout(timer)

		if (!answered) {
			log.warn(`updater: Squirrel did not answer within ${String(SQUIRREL_WAIT_MS / 1000)} s`)
			// The staged version stays, so a late answer still makes it ready; the next check hands it over again.
			pending.resolve()

			if (squirrel === pending) {
				squirrel = null
			}
		}
	}

	async function check(): Promise<void> {
		if (!shouldCheckForUpdate(state)) {
			return
		}

		state.checking = true
		stall.arm()

		try {
			const updater = await loading
			const result = await updater.checkForUpdates()

			// Held until the download settles, so the next interval never starts a second one.
			await result?.downloadPromise
			await squirrelAnswer()
		} catch (error) {
			// Squirrel was never handed a complete download.
			settleSquirrel()
			log.warn(`updater: check failed: ${messageOf(error)}`)
		} finally {
			stall.disarm()
			state.checking = false
		}
	}

	const interval = updateCheckInterval(testFeed)

	setTimeout(() => {
		void check()
		setInterval(() => {
			void check()
		}, interval)
	}, UPDATE_FIRST_CHECK_DELAY_MS)

	return {
		ready: () => state.ready,
		install: () => {
			const updater = loaded

			if (state.ready === null || updater === null || installing) {
				return false
			}

			installing = true

			try {
				// Silent on Windows (the NSIS installer runs without its wizard, elevating if needed) and relaunched. A
				// failure to start the installer comes as an error event, at once or (an elevation) later.
				updater.quitAndInstall(true, true)
			} catch (error) {
				installFailed(messageOf(error))
			}

			return true
		}
	}
}
