import { contextBridge, ipcRenderer } from "electron"
import type { DesktopBridge, DesktopPlatform } from "@filen/shared/desktop"
import { CHANNELS, type SessionRead } from "../shared/channels.ts"

// The sandboxed preload's process object carries the platform but no Node typings.
declare const process: { readonly platform: DesktopPlatform }

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
	}
}

contextBridge.exposeInMainWorld("desktop", bridge)
