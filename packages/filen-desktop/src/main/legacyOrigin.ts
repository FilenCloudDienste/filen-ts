import { stat } from "node:fs/promises"
import path from "node:path"
import { BrowserWindow, protocol, session } from "electron"
import { codedError, errorCode } from "./atomicFile.ts"

// The old client served its web app on filendesktop://bundle, so its localStorage belongs to that origin of the
// default session. The scheme is registered with the old privileges (standard and secure decide the origin and
// whether it has storage at all); the handler serves one empty page and nothing of the old app.
export const LEGACY_SCHEME = "filendesktop"
const LEGACY_URL = `${LEGACY_SCHEME}://bundle/`

// A read or wipe that takes longer is abandoned and tried again on a later launch.
export const LEGACY_TIMEOUT_MS = 15 * 1000

const PAGE = "<!doctype html><title>Filen</title>"

// The old origin's entries in userData/IndexedDB (Chromium names them after its scheme, host and port).
export const LEGACY_INDEXEDDB_PREFIX = `${LEGACY_SCHEME}_bundle_0.`

// Whether the old client's web app ever ran in this profile. It opened its IndexedDB stores as its bundle loaded, before
// any sign-in and before it wrote anything to localStorage, so every profile with something to import has them; nothing
// of this app opens IndexedDB in that origin before the migration's marker exists. Chromium creates the Local Storage
// store for any profile, a fresh one included, so that proves nothing. One stat; an error other than a missing entry
// rejects, so that launch decides nothing.
export async function legacyProfileExists(userData: string): Promise<boolean> {
	try {
		return (await stat(path.join(userData, "IndexedDB", `${LEGACY_INDEXEDDB_PREFIX}indexeddb.leveldb`))).isDirectory()
	} catch (error) {
		const code = errorCode(error)

		if (code === "ENOENT" || code === "ENOTDIR") {
			return false
		}

		throw error
	}
}

// The empty page at the root of the old origin, a 404 anywhere else.
export function legacyPageResponse(url: string): Response {
	const { host, pathname } = new URL(url)

	if (host !== "bundle" || pathname !== "/") {
		return new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
	}

	return new Response(PAGE, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'none'"
		}
	})
}

// Runs `script` in the old origin: a hidden, sandboxed window without a preload loads the empty page, main runs the
// script there and takes its result. The window is gone before this settles; DOM storage the script changed is
// flushed to disk first.
export async function runInLegacyOrigin(script: string): Promise<unknown> {
	if (!protocol.isProtocolHandled(LEGACY_SCHEME)) {
		protocol.handle(LEGACY_SCHEME, request => legacyPageResponse(request.url))
	}

	const window = new BrowserWindow({
		show: false,
		paintWhenInitiallyHidden: false,
		skipTaskbar: true,
		webPreferences: {
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			devTools: false,
			spellcheck: false
		}
	})
	const contents = window.webContents

	contents.setWindowOpenHandler(() => ({ action: "deny" }))
	contents.on("will-navigate", event => {
		event.preventDefault()
	})

	let timer: NodeJS.Timeout | undefined

	try {
		return await Promise.race([
			window.loadURL(LEGACY_URL).then(() => contents.executeJavaScript(script)),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(codedError("timeout"))
				}, LEGACY_TIMEOUT_MS)
			})
		])
	} finally {
		clearTimeout(timer)
		session.defaultSession.flushStorageData()
		window.destroy()
	}
}
