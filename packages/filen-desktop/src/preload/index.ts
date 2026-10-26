import { contextBridge, ipcRenderer } from "electron"
import type { DesktopBridge, DesktopPlatform } from "@filen/shared/desktop"
import { CHANNELS } from "../shared/channels.ts"

// The sandboxed preload's process object carries the platform but no Node typings.
declare const process: { readonly platform: DesktopPlatform }

const bridge: DesktopBridge = {
	platform: process.platform,
	setTitleBarColors: colors => {
		ipcRenderer.send(CHANNELS.setTitleBarColors, colors)
	}
}

contextBridge.exposeInMainWorld("desktop", bridge)
