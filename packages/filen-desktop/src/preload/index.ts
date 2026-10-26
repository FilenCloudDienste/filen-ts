import { contextBridge, ipcRenderer } from "electron"
import type {
	DesktopBridge,
	DesktopLockAttempt,
	DesktopLockStatus,
	DesktopLogsExport,
	DesktopMenuAction,
	DesktopPlatform,
	DesktopSyncActivity,
	DesktopSyncOverview,
	WindowState
} from "@filen/shared/desktop"
import { CHANNELS, type SessionRead, type SyncCall, syncChannel, VERSION_ARG_PREFIX } from "../shared/channels.ts"

// The sandboxed preload's process object carries the platform and argv but no Node typings.
declare const process: { readonly platform: DesktopPlatform; readonly argv: readonly string[] }

const version = process.argv.find(arg => arg.startsWith(VERSION_ARG_PREFIX))?.slice(VERSION_ARG_PREFIX.length) ?? ""

// Main sends the state once the page loads, possibly before the page subscribes, so the latest one is kept.
let windowState: WindowState | null = null
const windowStateListeners = new Set<(state: WindowState) => void>()

ipcRenderer.on(CHANNELS.windowState, (_event, state: WindowState) => {
	windowState = state

	for (const listener of windowStateListeners) {
		listener(state)
	}
})

const menuActionListeners = new Set<(action: DesktopMenuAction) => void>()

ipcRenderer.on(CHANNELS.menuAction, (_event, action: DesktopMenuAction) => {
	for (const listener of menuActionListeners) {
		listener(action)
	}
})

// Main sends a ready update when the page loads, possibly before the page subscribes, so it is kept like the state.
let updateReady: string | null = null
const updateReadyListeners = new Set<(version: string) => void>()

ipcRenderer.on(CHANNELS.updateReady, (_event, version: string) => {
	updateReady = version

	for (const listener of updateReadyListeners) {
		listener(version)
	}
})

const lockListeners = new Set<(status: DesktopLockStatus) => void>()

ipcRenderer.on(CHANNELS.lockChanged, (_event, status: DesktopLockStatus) => {
	for (const listener of lockListeners) {
		listener(status)
	}
})

// A revocation can arrive before the page subscribes, so it is kept.
let revoked = false
const revokedListeners = new Set<() => void>()

ipcRenderer.on(CHANNELS.sessionRevoked, () => {
	revoked = true

	for (const listener of revokedListeners) {
		listener()
	}
})

// Main streams the overview and activity only while the page listens to either; the latest overview is kept for
// late subscribers and dropped with the stream, since it goes stale without it.
let syncOverview: DesktopSyncOverview | null = null
let syncSubscribed = false
const syncOverviewListeners = new Set<(overview: DesktopSyncOverview) => void>()
const syncActivityListeners = new Set<(entries: DesktopSyncActivity[]) => void>()

function syncSubscription(): void {
	const subscribed = syncOverviewListeners.size + syncActivityListeners.size > 0

	if (subscribed !== syncSubscribed) {
		syncSubscribed = subscribed

		if (!subscribed) {
			syncOverview = null
		}

		ipcRenderer.send(CHANNELS.syncSubscribe, subscribed)
	}
}

ipcRenderer.on(CHANNELS.syncOverview, (_event, overview: DesktopSyncOverview) => {
	syncOverview = overview

	for (const listener of syncOverviewListeners) {
		listener(overview)
	}
})

ipcRenderer.on(CHANNELS.syncActivity, (_event, entries: DesktopSyncActivity[]) => {
	for (const listener of syncActivityListeners) {
		listener(entries)
	}
})

// A clicked notification can arrive before the page listens; it is delivered on subscribing.
let pendingOpenPairs: string[] = []
const openPairListeners = new Set<(pairId: string) => void>()

ipcRenderer.on(CHANNELS.syncOpenPair, (_event, pairId: string) => {
	if (openPairListeners.size === 0) {
		pendingOpenPairs = [...pendingOpenPairs.filter(pending => pending !== pairId), pairId]

		return
	}

	for (const listener of openPairListeners) {
		listener(pairId)
	}
})

// Main answers each call with the type the bridge declares for it.
function syncInvoke(call: SyncCall, ...args: unknown[]): Promise<never> {
	return ipcRenderer.invoke(syncChannel(call), ...args) as Promise<never>
}

const bridge: DesktopBridge = {
	platform: process.platform,
	session: {
		get: async () => {
			const read = (await ipcRenderer.invoke(CHANNELS.sessionGet)) as SessionRead

			if (read.status === "unreadable") {
				throw new Error("The saved sign-in could not be read. Unlock the system keychain, then reload.")
			}

			return read.status === "present" ? read.blob : null
		},
		set: async blob => {
			await ipcRenderer.invoke(CHANNELS.sessionSet, blob)
		},
		clear: async () => {
			await ipcRenderer.invoke(CHANNELS.sessionClear)
		},
		markVerified: () => {
			ipcRenderer.send(CHANNELS.sessionVerified)
		},
		onRevoked: callback => {
			revokedListeners.add(callback)

			if (revoked) {
				callback()
			}

			return () => {
				revokedListeners.delete(callback)
			}
		}
	},
	prefs: {
		get: () => ipcRenderer.invoke(CHANNELS.prefsGet),
		set: patch => ipcRenderer.invoke(CHANNELS.prefsSet, patch)
	},
	app: {
		version,
		setBadge: count => {
			ipcRenderer.send(CHANNELS.setBadge, count)
		},
		setUnloadHolds: count => {
			ipcRenderer.send(CHANNELS.setUnloadHolds, count)
		},
		setAudioPlaying: playing => {
			ipcRenderer.send(CHANNELS.setAudioPlaying, playing)
		},
		setMenuShortcuts: combos => {
			ipcRenderer.send(CHANNELS.setMenuShortcuts, combos)
		},
		onMenuAction: callback => {
			menuActionListeners.add(callback)

			if (menuActionListeners.size === 1) {
				ipcRenderer.send(CHANNELS.menuReady)
			}

			return () => {
				menuActionListeners.delete(callback)
			}
		},
		onUpdateReady: callback => {
			updateReadyListeners.add(callback)

			if (updateReady !== null) {
				callback(updateReady)
			}

			return () => {
				updateReadyListeners.delete(callback)
			}
		},
		installUpdate: () => {
			ipcRenderer.send(CHANNELS.installUpdate)
		}
	},
	lock: {
		status: () => ipcRenderer.invoke(CHANNELS.lockStatus) as Promise<DesktopLockStatus>,
		onChanged: callback => {
			lockListeners.add(callback)

			return () => {
				lockListeners.delete(callback)
			}
		},
		unlock: pin => ipcRenderer.invoke(CHANNELS.lockUnlock, pin) as Promise<DesktopLockAttempt>,
		set: (pin, currentPin) => ipcRenderer.invoke(CHANNELS.lockSet, pin, currentPin) as Promise<DesktopLockAttempt>,
		clear: currentPin => ipcRenderer.invoke(CHANNELS.lockClear, currentPin) as Promise<DesktopLockAttempt>,
		lock: () => {
			ipcRenderer.send(CHANNELS.lockNow)
		},
		reset: async () => {
			await ipcRenderer.invoke(CHANNELS.lockReset)
		}
	},
	logs: {
		export: webLog => ipcRenderer.invoke(CHANNELS.logsExport, webLog) as Promise<DesktopLogsExport>
	},
	sync: {
		overview: () => syncInvoke("overview"),
		onOverview: callback => {
			syncOverviewListeners.add(callback)

			if (syncOverview !== null) {
				callback(syncOverview)
			}

			syncSubscription()

			return () => {
				syncOverviewListeners.delete(callback)
				syncSubscription()
			}
		},
		activity: (pairId, limit) => syncInvoke("activity", pairId, limit),
		onActivity: callback => {
			syncActivityListeners.add(callback)
			syncSubscription()

			return () => {
				syncActivityListeners.delete(callback)
				syncSubscription()
			}
		},
		chooseLocalDirectory: () => syncInvoke("chooseLocalDirectory"),
		addPair: pair => syncInvoke("addPair", pair),
		startPair: pairId => syncInvoke("startPair", pairId),
		removePair: pairId => syncInvoke("removePair", pairId),
		pausePair: pairId => syncInvoke("pausePair", pairId),
		resumePair: pairId => syncInvoke("resumePair", pairId),
		setMode: (pairId, mode, backlog) => syncInvoke("setMode", pairId, mode, backlog),
		renamePair: (pairId, name) => syncInvoke("renamePair", pairId, name),
		syncNow: pairId => syncInvoke("syncNow", pairId),
		plan: pairId => syncInvoke("plan", pairId),
		planPage: (planId, list, offset, limit) => syncInvoke("planPage", planId, list, offset, limit),
		releasePlan: planId => syncInvoke("releasePlan", planId),
		conflicts: (pairId, offset, limit) => syncInvoke("conflicts", pairId, offset, limit),
		resolveConflict: (pairId, relPath, resolution) => syncInvoke("resolveConflict", pairId, relPath, resolution),
		heldDeletions: pairId => syncInvoke("heldDeletions", pairId),
		approveDeletions: (pairId, passToken) => syncInvoke("approveDeletions", pairId, passToken),
		retryPath: (pairId, relPath) => syncInvoke("retryPath", pairId, relPath),
		ignoredPaths: (pairId, offset, limit) => syncInvoke("ignoredPaths", pairId, offset, limit),
		userIgnore: () => syncInvoke("userIgnore"),
		setUserIgnore: text => syncInvoke("setUserIgnore", text),
		reveal: (pairId, target) => syncInvoke("reveal", pairId, target),
		dismissNotice: (pairId, notice) => syncInvoke("dismissNotice", pairId, notice),
		retryHost: () => {
			void syncInvoke("retryHost")
		},
		onOpenPair: callback => {
			openPairListeners.add(callback)

			const pending = pendingOpenPairs

			pendingOpenPairs = []

			for (const pairId of pending) {
				callback(pairId)
			}

			return () => {
				openPairListeners.delete(callback)
			}
		}
	},
	setTitleBarColors: colors => {
		ipcRenderer.send(CHANNELS.setTitleBarColors, colors)
	},
	onWindowState: callback => {
		windowStateListeners.add(callback)

		if (windowState !== null) {
			callback(windowState)
		}

		return () => {
			windowStateListeners.delete(callback)
		}
	},
	showWindow: () => {
		ipcRenderer.send(CHANNELS.showWindow)
	}
}

contextBridge.exposeInMainWorld("desktop", bridge)
