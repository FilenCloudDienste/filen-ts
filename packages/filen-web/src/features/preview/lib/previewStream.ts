import type { AnyFile } from "@filen/sdk-rs"
import { activeServiceWorker, ensureSwClientReady, sendToSw } from "@/features/drive/lib/saveDownload"
import { SW_DOWNLOAD_PREFIX, SW_MSG_REGISTER_PREVIEW } from "@/lib/sw/protocol"

// Registers `file` against the SW's inline-preview route (no attachment disposition, an allowlisted
// Content-Type, Range/206-capable) and returns its fetchable, same-origin URL — the src a
// <video>/<audio>/<img> element streams+seeks against directly. Mirrors save-download.ts's own
// triggerSwDownload registration step, minus the FSA branch and the plain-navigation trigger: an
// inline media element just needs a stable URL, it never "saves" anything.
export async function previewStreamUrl(file: AnyFile, name: string, contentType: string): Promise<string> {
	await ensureSwClientReady()

	const target = await activeServiceWorker()
	const id = crypto.randomUUID()

	await sendToSw(target, SW_MSG_REGISTER_PREVIEW, { id, file, name, size: Number(file.size), contentType })

	return `${SW_DOWNLOAD_PREFIX}${id}`
}

// Capability gate: true once a service worker is actually controlling this tab — the SW is PROD-only
// (lib/sw/register.ts never registers one under dev), so this is false there and true under
// `npm run preview`/a real deploy once boot has claimed the page. This is the single flip point every
// streamed viewer branches on before ever calling previewStreamUrl — if inline streaming ever proves
// unreliable in a real browser, forcing this false alone reroutes every viewer to the buffered blob
// fallback, no other call site needs to change.
export function isMediaStreamAvailable(): boolean {
	return "serviceWorker" in navigator && navigator.serviceWorker.controller !== null
}
