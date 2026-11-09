import { describe, expect, it, vi } from "vitest"
import { CHANNELS } from "../shared/channels.ts"
import { registerBrowserCacheIpc, sessionBrowserCache, type CacheSession } from "../main/browserCache.ts"
import type { IpcEvent, IpcMain } from "../main/pages.ts"

const APP = "filen://app/"

function fakeSession(): CacheSession & { clearStorageData: () => Promise<void> } {
	return {
		getCacheSize: vi.fn(() => Promise.resolve(1234)),
		clearCache: vi.fn(() => Promise.resolve()),
		clearCodeCaches: vi.fn(() => Promise.resolve()),
		clearStorageData: vi.fn(() => Promise.resolve())
	}
}

function register(session: CacheSession) {
	const handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
	const ipc: IpcMain = {
		handle: (channel, listener) => {
			handlers.set(channel, listener)
		},
		on: vi.fn()
	}

	registerBrowserCacheIpc(
		ipc,
		sessionBrowserCache(() => session),
		url => url?.startsWith(APP) === true
	)

	const invoke = (channel: string, url: string | null, ...args: unknown[]) => {
		const handler = handlers.get(channel)

		if (handler === undefined) {
			throw new Error(`${channel} not registered`)
		}

		return Promise.resolve().then(() =>
			handler({ senderFrame: url === null ? null : { url }, sender: { id: 1, send: vi.fn(), isDestroyed: () => false } }, ...args)
		)
	}

	return { invoke, handlers }
}

describe("browser cache IPC", () => {
	it("registers exactly its own two channels, apart from the mounts cache", () => {
		const { handlers } = register(fakeSession())

		expect([...handlers.keys()].sort()).toEqual([CHANNELS.browserCacheSize, CHANNELS.clearBrowserCache].sort())
	})

	it("answers the HTTP cache size", async () => {
		const session = fakeSession()
		const { invoke } = register(session)

		await expect(invoke(CHANNELS.browserCacheSize, APP)).resolves.toBe(1234)
	})

	it("clears the HTTP and compiled-code caches and never site storage", async () => {
		const session = fakeSession()
		const { invoke } = register(session)

		await invoke(CHANNELS.clearBrowserCache, APP)

		expect(session.clearCache).toHaveBeenCalledOnce()
		expect(session.clearCodeCaches).toHaveBeenCalledWith({})
		expect(session.clearStorageData).not.toHaveBeenCalled()
	})

	it("refuses another sender and any argument", async () => {
		const session = fakeSession()
		const { invoke } = register(session)

		await expect(invoke(CHANNELS.clearBrowserCache, "https://evil.example/")).rejects.toThrow("untrusted sender")
		await expect(invoke(CHANNELS.browserCacheSize, null)).rejects.toThrow("untrusted sender")
		await expect(invoke(CHANNELS.clearBrowserCache, APP, {})).rejects.toThrow("invalid browser cache payload")
		expect(session.clearCache).not.toHaveBeenCalled()
		expect(session.getCacheSize).not.toHaveBeenCalled()
	})
})
