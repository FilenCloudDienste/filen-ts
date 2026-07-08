import type { AnyFile, ZipItem } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { SW_DOWNLOAD_PREFIX, SW_MSG_INIT_CLIENT, SW_MSG_REGISTER_DOWNLOAD, SW_MSG_REGISTER_ZIP_DOWNLOAD } from "@/lib/sw/protocol"

// The disk mechanism a download writes to, picked once per saveDownload() call by capability —
// callers (lib/drive/download.ts) branch on `kind`, never on the browser directly. FSA carries a
// real writable sink; the SW branch carries just enough (an opaque token + the virtual URL) for
// triggerSwDownload to register the concrete file against it once one is known.
export interface FsaSaveTarget {
	kind: "fsa"
	writable: FileSystemWritableFileStream
}

export interface SwSaveTarget {
	kind: "sw"
	id: string
	url: string
	name: string
}

export type SaveTarget = FsaSaveTarget | SwSaveTarget

// Chromium-only feature detect — Firefox/Safari fall through to the SW route in saveDownload below.
export function isFsaAvailable(): boolean {
	return typeof window.showSaveFilePicker === "function"
}

// showSaveFilePicker() rejects with a DOMException named "AbortError" when the user dismisses the
// save dialog without choosing a location — that is a deliberate no-op, never an error toast. Duck-
// typed (not `instanceof DOMException`) so it recognizes both a real browser rejection and a plain
// `{name: "AbortError"}` test double, mirroring lib/sdk/errors.ts's own isSdkError shape probe.
export function isPickerCancelled(e: unknown): boolean {
	return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError"
}

async function pickFsaTarget(suggestedName: string): Promise<FsaSaveTarget> {
	const picker = window.showSaveFilePicker

	if (picker === undefined) {
		throw new Error("File System Access is not available")
	}

	const handle = await picker({ suggestedName })
	const writable = await handle.createWritable()

	return { kind: "fsa", writable }
}

// One MessageChannel round trip to the active service worker: post `{type, ...payload}` with the
// channel's port2 transferred, resolve/reject on its single ack (`{ok: true}` / `{ok: false, error}`)
// — the exact reply shape sw.ts's own message listener posts back for SW_MSG_INIT_CLIENT and
// SW_MSG_REGISTER_DOWNLOAD.
function sendToSw(target: ServiceWorker, type: string, payload: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const channel = new MessageChannel()

		channel.port1.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
			if (event.data.ok) {
				resolve()
			} else {
				reject(new Error(event.data.error ?? "service worker request failed"))
			}
		}

		target.postMessage({ type, ...payload }, [channel.port2])
	})
}

async function activeServiceWorker(): Promise<ServiceWorker> {
	const registration = await navigator.serviceWorker.ready
	const target = registration.active

	if (target === null) {
		throw new Error("no active service worker")
	}

	return target
}

// Hands the current session's StringifiedClient to the SW so it can reconstruct its own trimmed
// Client (sw.ts's adoptSwClient) — memoized for the tab's lifetime so a batch of downloads only
// pays for one handoff. A failed attempt clears the memo so the next call retries instead of
// permanently wedging every future download behind one transient failure.
let swClientReady: Promise<void> | null = null

async function initSwClient(): Promise<void> {
	const blob = await sdkApi.toStringified()
	const target = await activeServiceWorker()

	await sendToSw(target, SW_MSG_INIT_CLIENT, { blob })
}

function ensureSwClientReady(): Promise<void> {
	swClientReady ??= initSwClient().catch((e: unknown) => {
		swClientReady = null

		throw e
	})

	return swClientReady
}

async function prepareSwTarget(suggestedName: string): Promise<SwSaveTarget> {
	await ensureSwClientReady()

	const id = crypto.randomUUID()

	return { kind: "sw", id, url: `${SW_DOWNLOAD_PREFIX}${id}`, name: suggestedName }
}

// FSA branch MUST run synchronously off the calling user gesture (no await before
// showSaveFilePicker) — callers invoke this directly inside a click handler, never behind an
// already-awaited step. SW branch has no such constraint (no native picker involved).
export async function saveDownload(suggestedName: string): Promise<SaveTarget> {
	if (isFsaAvailable()) {
		return pickFsaTarget(suggestedName)
	}

	return prepareSwTarget(suggestedName)
}

// Finalizes a "sw" SaveTarget once the concrete file is known: registers it against the token
// saveDownload minted (SW_MSG_REGISTER_DOWNLOAD), then triggers a PLAIN navigation — never `<a
// download>`, which bypasses the controlling service worker entirely (verified empirically: the
// download attribute routes the request through the browser's own download manager, never through
// this origin's SW). The SW's Content-Disposition: attachment response turns the navigation into a
// browser-native file save without actually leaving the page.
export async function triggerSwDownload(file: AnyFile, save: SwSaveTarget): Promise<void> {
	const target = await activeServiceWorker()

	await sendToSw(target, SW_MSG_REGISTER_DOWNLOAD, { id: save.id, file, name: save.name, size: Number(file.size) })

	window.location.href = save.url
}

// Zip flavor of triggerSwDownload above — same registration-then-plain-navigation shape, just a
// different message type and no `size` (a zip's total isn't known until the SW streams it).
export async function triggerSwZipDownload(items: ZipItem[], save: SwSaveTarget): Promise<void> {
	const target = await activeServiceWorker()

	await sendToSw(target, SW_MSG_REGISTER_ZIP_DOWNLOAD, { id: save.id, items, name: save.name })

	window.location.href = save.url
}
