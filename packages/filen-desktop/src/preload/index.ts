import { contextBridge, ipcRenderer } from "electron"
import type {
	DesktopBridge,
	DesktopLockAttempt,
	DesktopLockStatus,
	DesktopLogsExport,
	DesktopMenuAction,
	DesktopPlatform,
	WindowState
} from "@filen/shared/desktop"
import { CHANNELS, type SessionRead, VERSION_ARG_PREFIX } from "../shared/channels.ts"

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
