import type { AnyFile, AnyItemWithContext } from "@filen/sdk-rs"
import { isAbortError } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { ErrorWithDTO } from "@/lib/sdk/errors"
import { allowNextUnload } from "@/lib/unloadGuard"
import { pipeWorkerToSink } from "@/lib/pipeWorkerToSink"
import {
	SW_DOWNLOAD_PREFIX,
	SW_DOWNLOAD_STALL_MS,
	SW_ERROR_NO_CLIENT,
	SW_KEEPALIVE_MS,
	SW_MSG_CANCEL_DOWNLOAD,
	SW_MSG_INIT_CLIENT,
	SW_MSG_KEEPALIVE,
	SW_MSG_LOGOUT,
	SW_MSG_REGISTER_DOWNLOAD,
	SW_MSG_REGISTER_ZIP_DOWNLOAD,
	SW_MSG_WATCH_DOWNLOAD,
	SW_REQUEST_TIMEOUT_MS,
	type SwDownloadStatus
} from "@/lib/sw/protocol"

// The disk mechanism a download writes to, picked once per saveDownload() call by capability —
// callers (features/drive/lib/download.ts) branch on `kind`, never on the browser directly. FSA carries a
// real writable sink; the SW branch carries just enough (an opaque token + the virtual URL) for
// triggerSwDownload to register the concrete file against it once one is known.
export interface FsaSaveTarget {
	kind: "fsa"
	handle: FileSystemFileHandle
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
// save dialog without choosing a location — that is a deliberate no-op, never an error toast.
// isAbortError's duck-typed name check also recognizes a plain `{name: "AbortError"}` test double.
export function isPickerCancelled(e: unknown): boolean {
	return isAbortError(e)
}

export async function pickFsaTarget(suggestedName: string): Promise<FsaSaveTarget> {
	const picker = window.showSaveFilePicker

	if (picker === undefined) {
		throw new Error("File System Access is not available")
	}

	const handle = await picker({ suggestedName })
	const writable = await handle.createWritable()

	return { kind: "fsa", handle, writable }
}

// Picking a location already created the file, emptying one the user chose to overwrite, and aborting
// the write only drops the browser's swap copy. A download that fails or is cancelled therefore
// deletes the file too, rather than leaving an empty one behind. Best effort: remove() is Chromium
// 110+ and fails while a writer still holds the file, so the write is aborted first.
export async function discardPickedFile(target: FsaSaveTarget): Promise<void> {
	await target.writable.abort().catch(() => undefined)
	await target.handle.remove?.().catch(() => undefined)
}

// Saves a fully-buffered blob via a transient anchor. The object URL is revoked after a delay so the
// browser has grabbed the download before it is released (an immediate revoke cancels the save in some
// browsers).
export function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement("a")

	anchor.href = url
	anchor.download = name
	document.body.appendChild(anchor)
	anchor.click()
	anchor.remove()

	setTimeout(() => {
		URL.revokeObjectURL(url)
	}, 10_000)
}

// Writes a buffer already in memory to the picked file. The buffer is only read, never detached.
export async function writeBytesToPickedFile(target: FsaSaveTarget, bytes: Uint8Array): Promise<void> {
	await target.writable.write(bytes as Uint8Array<ArrayBuffer>)
	await target.writable.close()
}

// Streams a worker's output into the picked file, discarding the file if the stream fails.
export async function pipeToPickedFile(
	target: FsaSaveTarget,
	run: (transferred: WritableStream<Uint8Array>) => Promise<void>
): Promise<void> {
	try {
		await pipeWorkerToSink(target.writable, run)
	} catch (e) {
		await discardPickedFile(target)

		throw e
	}
}

// One MessageChannel round trip to the active service worker: post `{type, ...payload}` with the
// channel's port2 transferred, resolve/reject on its single ack (`{ok: true}` / `{ok: false, error}`)
// — the exact reply shape sw.ts's own message listener posts back for SW_MSG_INIT_CLIENT and
// SW_MSG_REGISTER_DOWNLOAD. The port is closed on every outcome, timeout included, so a wedged worker
// can't stall a download behind an unresolvable promise.
export function sendToSw(target: ServiceWorker, type: string, payload: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const channel = new MessageChannel()
		const timeout = setTimeout(() => {
			close()
			reject(new Error("service worker did not respond"))
		}, SW_REQUEST_TIMEOUT_MS)

		function close(): void {
			clearTimeout(timeout)
			channel.port1.close()
		}

		channel.port1.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
			close()

			if (event.data.ok) {
				resolve()
			} else {
				reject(new Error(event.data.error ?? "service worker request failed"))
			}
		}

		target.postMessage({ type, ...payload }, [channel.port2])
	})
}

export async function activeServiceWorker(): Promise<ServiceWorker> {
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

export function ensureSwClientReady(): Promise<void> {
	swClientReady ??= initSwClient().catch((e: unknown) => {
		swClientReady = null

		throw e
	})

	return swClientReady
}

// The single registration seam for every SW-served route (download, zip, preview). It also heals the
// one failure the page cannot otherwise see: a service worker is terminated whenever it goes idle and
// restarts with empty module globals, so the session Client handed over once per tab is gone while the
// memo above still says it isn't. The worker reports that as SW_ERROR_NO_CLIENT instead of a hollow ok
// — re-hand the session over and retry once, so the download/preview just works instead of 404ing.
export async function registerWithSw(type: string, payload: Record<string, unknown>): Promise<void> {
	const handoff = ensureSwClientReady()

	await handoff

	try {
		await sendToSw(await activeServiceWorker(), type, payload)
	} catch (e) {
		if (!(e instanceof Error) || e.message !== SW_ERROR_NO_CLIENT) {
			throw e
		}

		// Only the first of several concurrent registrations invalidates the memo; the rest await whatever
		// re-init it started, so one restart never triggers several handoffs (each frees the previous
		// Client, which a stream started in between would be holding).
		if (swClientReady === handoff) {
			swClientReady = null
		}

		await ensureSwClientReady()
		await sendToSw(await activeServiceWorker(), type, payload)
	}
}

// Tells the controlling service worker to drop this session's decrypted key material (its
// reconstructed Client + every pending download) at logout, and forgets the tab-lifetime handoff memo
// so a later sign-in re-inits a fresh client. Targets `controller` (never `navigator.serviceWorker.ready`,
// which blocks forever when no worker controls the page — e.g. dev, or before the first activation)
// and never lets a dead-but-registered worker's missing or failed ack wedge sign-out: the imminent
// reload tears the worker down regardless, so a lost ack is not fatal.
export async function wipeSwClient(): Promise<void> {
	swClientReady = null

	if (!("serviceWorker" in navigator)) {
		return
	}

	const target = navigator.serviceWorker.controller

	if (target === null) {
		return
	}

	await Promise.race([
		sendToSw(target, SW_MSG_LOGOUT, {}).catch(() => undefined),
		new Promise<void>(resolve => {
			setTimeout(resolve, 1000)
		})
	])
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

// The row's Cancel for a download the service worker streams: the page's own SDK isn't running it, so
// cancelTransfers (features/transfers/lib/control.ts) asks here first. Keyed by transfer id.
const swDownloadCancels = new Map<string, () => void>()

// True when the transfer is a service-worker download, whose cancel has now been sent.
export function cancelSwDownload(transferId: string): boolean {
	const cancel = swDownloadCancels.get(transferId)

	cancel?.()

	return cancel !== undefined
}

// One timer for every streaming download, however many: each holds a reference until it settles.
let keepAliveHolds = 0
let keepAliveTimer: ReturnType<typeof setInterval> | undefined

function holdWorkerAlive(worker: ServiceWorker): () => void {
	keepAliveHolds++

	if (keepAliveHolds === 1) {
		keepAliveTimer = setInterval(() => {
			worker.postMessage({ type: SW_MSG_KEEPALIVE })
		}, SW_KEEPALIVE_MS)
	}

	let held = true

	return () => {
		if (!held) {
			return
		}

		held = false
		keepAliveHolds--

		if (keepAliveHolds === 0) {
			clearInterval(keepAliveTimer)
		}
	}
}

// Starts a registered download and settles when the service worker reports how it ended: the browser's
// download manager owns the save from the navigation on, so without this a failed or cancelled download
// would read as finished. Rejects with the reported ErrorDTO (kind "Cancelled" for a cancel from the row
// or from the browser's own download UI), or once the worker has been silent for SW_DOWNLOAD_STALL_MS — it
// repeats its progress while streaming, so silence means the browser terminated it. While it streams, the
// page keeps the worker alive (SW_MSG_KEEPALIVE).
async function startWatchedSwDownload(
	save: SwSaveTarget,
	transferId: string,
	onProgress: (bytes: number, total: number | null) => void
): Promise<void> {
	// An uncontrolled page (after a hard reload) would send the navigation to the network, which answers it
	// with the app itself in place of a file.
	if (navigator.serviceWorker.controller === null) {
		throw new Error("downloads need the page reloaded")
	}

	const target = await activeServiceWorker()
	const channel = new MessageChannel()
	const releaseWorker = holdWorkerAlive(target)

	const outcome = new Promise<void>((resolve, reject) => {
		let stall: ReturnType<typeof setTimeout> | undefined

		function finish(): void {
			clearTimeout(stall)
			releaseWorker()
			channel.port1.close()
			swDownloadCancels.delete(transferId)
		}

		function armStall(): void {
			clearTimeout(stall)
			stall = setTimeout(() => {
				finish()
				reject(new Error("the download stopped responding"))
			}, SW_DOWNLOAD_STALL_MS)
		}

		channel.port1.onmessage = (event: MessageEvent<SwDownloadStatus>) => {
			const status = event.data

			if (status.type === "progress") {
				armStall()
				onProgress(status.bytes, status.total)

				return
			}

			finish()

			if (status.type === "done") {
				resolve()
			} else {
				reject(new ErrorWithDTO(status.error))
			}
		}

		swDownloadCancels.set(transferId, () => {
			target.postMessage({ type: SW_MSG_CANCEL_DOWNLOAD, id: save.id })
		})
		armStall()
	})

	target.postMessage({ type: SW_MSG_WATCH_DOWNLOAD, id: save.id }, [channel.port2])

	// Starts a download, not a page change: the leave-page prompt must stay out of it.
	allowNextUnload()
	window.location.href = save.url

	await outcome
}

// Finalizes a "sw" SaveTarget once the concrete file is known: registers it against the token
// saveDownload minted (SW_MSG_REGISTER_DOWNLOAD), then triggers a PLAIN navigation — never `<a
// download>`, which bypasses the controlling service worker entirely (verified empirically: the
// download attribute routes the request through the browser's own download manager, never through
// this origin's SW). The SW's Content-Disposition: attachment response turns the navigation into a
// browser-native file save without actually leaving the page.
export async function triggerSwDownload(
	file: AnyFile,
	save: SwSaveTarget,
	transferId: string,
	onProgress: (bytes: number) => void
): Promise<void> {
	await registerWithSw(SW_MSG_REGISTER_DOWNLOAD, { id: save.id, file, name: save.name, size: Number(file.size) })
	await startWatchedSwDownload(save, transferId, bytes => {
		onProgress(bytes)
	})
}

// Zip flavor of triggerSwDownload above — same registration-then-plain-navigation shape, just a
// different message type and no `size` (a zip's total isn't known until the SW streams it).
export async function triggerSwZipDownload(
	items: AnyItemWithContext[],
	save: SwSaveTarget,
	transferId: string,
	onProgress: (bytesWritten: number, totalBytes: number | null) => void
): Promise<void> {
	await registerWithSw(SW_MSG_REGISTER_ZIP_DOWNLOAD, { id: save.id, items, name: save.name })
	await startWatchedSwDownload(save, transferId, onProgress)
}
