import type { IpcEvent, IpcMain } from "../main/pages.ts"

// An IpcMain that keeps what was registered: `handlers` by handle(), `listeners` by on(), each by channel.
export function fakeIpc(): {
	ipc: IpcMain
	handlers: Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>
	listeners: Map<string, (event: IpcEvent, ...args: unknown[]) => void>
} {
	const handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
	const listeners = new Map<string, (event: IpcEvent, ...args: unknown[]) => void>()
	const ipc: IpcMain = {
		handle: (channel, listener) => {
			handlers.set(channel, listener)
		},
		on: (channel, listener) => {
			listeners.set(channel, listener)
		}
	}

	return { ipc, handlers, listeners }
}
