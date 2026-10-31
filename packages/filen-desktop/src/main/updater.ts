import type { AppUpdater } from "electron-updater"

// The first check waits a little, so it never competes with startup; later ones run on an interval.
export const UPDATE_FIRST_CHECK_DELAY_MS = 15 * 1000
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

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
	// Starts the downloaded update's installer and quits, relaunching after. False when it could not start (nothing
	// downloaded, the installer missing): the app keeps running and the update stays for the next quit.
	install(): boolean
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
// user restarts from the page's prompt or on the next quit. Loaded on first use, so startup never evaluates it.
export function startUpdater(log: UpdaterLog, onReady: (version: string) => void, testFeed: string | null): Updater {
	const state: UpdateCheckState = { checking: false, ready: null }
	// Set with `ready`: a download implies the module loaded.
	let loaded: AppUpdater | null = null
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
	const loading = import("electron-updater").then(({ autoUpdater }) => {
		autoUpdater.logger = updaterLog
		autoUpdater.autoDownload = true
		autoUpdater.autoInstallOnAppQuit = true

		if (testFeed !== null) {
			autoUpdater.setFeedURL({ provider: "generic", url: testFeed })
			log.info(`updater: test feed ${testFeed}`)
		}

		autoUpdater.on("update-downloaded", info => {
			loaded = autoUpdater
			state.ready = info.version
			onReady(info.version)
		})

		return autoUpdater
	})

	// Reported by the check that awaits it.
	loading.catch(() => undefined)

	async function check(): Promise<void> {
		if (!shouldCheckForUpdate(state)) {
			return
		}

		state.checking = true

		try {
			const updater = await loading
			const result = await updater.checkForUpdates()

			// Held until the download settles, so the next interval never starts a second one.
			await result?.downloadPromise
		} catch (error) {
			log.warn(`updater: check failed: ${messageOf(error)}`)
		} finally {
			state.checking = false
		}
	}

	setTimeout(() => {
		void check()
		setInterval(() => {
			void check()
		}, UPDATE_CHECK_INTERVAL_MS)
	}, UPDATE_FIRST_CHECK_DELAY_MS)

	return {
		ready: () => state.ready,
		install: () => {
			const updater = loaded

			if (state.ready === null || updater === null) {
				return false
			}

			// A failure to start the installer is reported synchronously, as an error event; one after it has started
			// does not stop the quit.
			let failed = false
			const onError = () => {
				failed = true
			}

			updater.once("error", onError)

			try {
				// Silent on Windows (the NSIS installer runs without its wizard, elevating if needed) and relaunched.
				updater.quitAndInstall(true, true)
			} catch (error) {
				log.warn(`updater: install failed: ${messageOf(error)}`)
				failed = true
			} finally {
				updater.off("error", onError)
			}

			return !failed
		}
	}
}
