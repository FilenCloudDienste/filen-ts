import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { createSyncRangeBuffer, SYNC_RANGE_DEFAULT_SLOTS, type PdfByteChannel } from "@filen/office/dom/pdfedit"
import { sdkApi } from "@/lib/sdk/client"
import { isAppleMobile } from "@/lib/appleMobile"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"

// A file's bytes for a synchronous reader (the PDF engine's MuPDF stream) in another worker: a shared buffer of
// BLOCK_BYTES slots the SDK worker writes the file's decrypted blocks into (sdk.worker openSyncRange), aligned with
// the SDK's own chunks so every byte downloads once. The page holds a Web Lock for as long as the bridge is wanted:
// releasing it (close(), or the page going away) shuts the SDK worker's side down.

// Slots in the ring (1 MiB each): fewer on iOS, whose tabs are killed first.
export function syncRangeSlots(): number {
	return isAppleMobile() ? SYNC_RANGE_DEFAULT_SLOTS / 2 : SYNC_RANGE_DEFAULT_SLOTS
}

export interface SyncRangeHandle {
	// For the engine's open request; its port is transferred with it.
	readonly channel: PdfByteChannel
	// Shuts the SDK worker's side down (the engine reading from it is closed or terminated first).
	close(): void
}

// Opens the bridge for `file` under `token` (cancelPreviewDownload(token) aborts it too).
export function openSyncRange(file: AnyFile, access: PreviewAccessMode, token: string): Promise<SyncRangeHandle> {
	return openSyncBridge(Number(file.size), (buffer, port, readerLock) =>
		access === "anon"
			? sdkApi.openLinkedSyncRangeAnon(buffer, port, file, token, readerLock)
			: sdkApi.openSyncRange(buffer, port, file, token, readerLock)
	)
}

// The page's side of a bridge over `length` bytes: the shared buffer, and the reader lock held for as long as the
// bridge is wanted. `serve` asks the SDK worker to serve it, the port transferred.
export async function openSyncBridge(
	length: number,
	serve: (buffer: SharedArrayBuffer, port: MessagePort, readerLock: string) => Promise<void>
): Promise<SyncRangeHandle> {
	const buffer = createSyncRangeBuffer(syncRangeSlots(), BLOCK_BYTES)
	const { port1, port2 } = new MessageChannel()
	const readerLock = `filen-sync-range-${crypto.randomUUID()}`
	const done = Promise.withResolvers<undefined>()
	const held = Promise.withResolvers<boolean>()

	if ("locks" in navigator) {
		void navigator.locks
			.request(readerLock, () => {
				held.resolve(true)

				return done.promise
			})
			.catch(() => {
				held.resolve(false)
			})
	} else {
		held.resolve(false)
	}

	await held.promise

	const transferred = Comlink.transfer(port2, [port2])

	try {
		await serve(buffer, transferred, readerLock)
	} catch (error) {
		done.resolve(undefined)
		port1.close()

		throw error
	}

	return {
		channel: { buffer, port: port1, length },
		close: () => {
			done.resolve(undefined)
			port1.close()
		}
	}
}
