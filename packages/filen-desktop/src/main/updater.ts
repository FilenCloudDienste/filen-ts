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
	// Quits and installs the downloaded update, relaunching after; nothing without one.
	install(): void
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value)
}

// electron-updater's generic provider on the feed electron-builder wrote into app-update.yml; Windows checks the
// installer's signature against the publisher named there. Downloads run in the background and install when the
// user restarts from the page's prompt or on the next quit. Loaded on first use, so startup never evaluates it.
export function startUpdater(log: UpdaterLog, onReady: (version: string) => void): Updater {
	const state: UpdateCheckState = { checking: false, ready: null }
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
		autoUpdater.on("update-downloaded", info => {
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
			if (state.ready === null) {
				return
			}

			void loading.then(updater => {
				// Silent on Windows (the NSIS installer runs without its wizard, elevating if needed) and relaunched.
				updater.quitAndInstall(true, true)
			})
		}
	}
}
