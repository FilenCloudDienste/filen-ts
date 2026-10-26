import { BrowserWindow, protocol, session } from "electron"
import { codedError } from "./atomicFile.ts"

// The old client served its web app on filendesktop://bundle, so its localStorage belongs to that origin of the
// default session. The scheme is registered with the old privileges (standard and secure decide the origin and
// whether it has storage at all); the handler serves one empty page and nothing of the old app.
export const LEGACY_SCHEME = "filendesktop"
const LEGACY_URL = `${LEGACY_SCHEME}://bundle/`

// A read or wipe that takes longer is abandoned and tried again on a later launch.
export const LEGACY_TIMEOUT_MS = 15 * 1000

const PAGE = "<!doctype html><title>Filen</title>"

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
