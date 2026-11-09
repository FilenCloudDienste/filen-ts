import { type } from "arktype"
import { CHANNELS } from "../shared/channels.ts"
import { checkedCalls, type IpcMain, registerCalls } from "./pages.ts"

// The window's disk caches the Storage settings page shows and clears: Chromium's HTTP cache and its compiled-code
// cache. Both refill on demand. Site storage (OPFS, the kv database, the session) is never touched here; only
// sign-out clears that.
export interface BrowserCache {
	size(): Promise<number>
	clear(): Promise<void>
}

// The parts of an Electron session the cache calls use.
export interface CacheSession {
	getCacheSize(): Promise<number>
	clearCache(): Promise<void>
	clearCodeCaches(options: object): Promise<void>
}

export function sessionBrowserCache(session: () => CacheSession): BrowserCache {
	return {
		size: () => session().getCacheSize(),
		clear: async () => {
			const current = session()

			await Promise.all([current.clearCache(), current.clearCodeCaches({})])
		}
	}
}

type BrowserCacheCall = "browserCacheSize" | "clearBrowserCache"

const call = checkedCalls<BrowserCache>("browser cache")

const CALLS: Record<BrowserCacheCall, ReturnType<typeof call>> = {
	browserCacheSize: call(type([]), cache => cache.size()),
	clearBrowserCache: call(type([]), cache => cache.clear())
}

// Answers the app's own top-level document only, with no arguments accepted.
export function registerBrowserCacheIpc(ipc: IpcMain, cache: BrowserCache, trusted: (senderUrl: string | undefined) => boolean): void {
	registerCalls(ipc, CALLS, name => CHANNELS[name], cache, trusted)
}
