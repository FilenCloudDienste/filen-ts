import { contextBridge, ipcRenderer } from "electron"
import type { DesktopBridge, DesktopPlatform, WindowState } from "@filen/shared/desktop"
import { CHANNELS, type SessionRead } from "../shared/channels.ts"

// The sandboxed preload's process object carries the platform but no Node typings.
declare const process: { readonly platform: DesktopPlatform }

// Main sends the state once the page loads, possibly before the page subscribes, so the latest one is kept.
let windowState: WindowState | null = null
const windowStateListeners = new Set<(state: WindowState) => void>()

ipcRenderer.on(CHANNELS.windowState, (_event, state: WindowState) => {
	windowState = state

	for (const listener of windowStateListeners) {
		listener(state)
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
	}
}

contextBridge.exposeInMainWorld("desktop", bridge)
