import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { bufferedSizeCap, CATEGORY_POLICY, previewType, unprobedTransportStream } from "@/features/drive/lib/preview.logic"
import { deviceProfile } from "@/lib/deviceProfile"

// Pure decisions behind the public-link download + preview surface — no worker, no DOM, no React, so
// every cap and branch is directly unit-testable. FSA streams to disk when the browser has it; otherwise the
// page's own download streams through the service worker into the browser's download (it only pipes, so an
// anonymous visitor needs no session there). Only where neither exists is the whole file buffered in memory,
// which is what the caps below bound.

// The one place the buffered ceiling lives. A browser with neither FSA nor the service worker route must hold
// the entire file in memory as a Blob before the anchor-download fires; past this it would risk crashing the
// tab, so the UI shows an honest "too large — use a Chromium browser or the desktop app" note instead.
export const PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES = 1_073_741_824n // 1 GiB

export type DownloadStrategy = { kind: "fsa" } | { kind: "stream" } | { kind: "buffered" } | { kind: "too-large" }

// Chooses how a single file saves. FSA and the service worker stream and are never capped; otherwise a file over
// the buffered cap is refused up front rather than attempted and OOM'd.
export function chooseDownloadStrategy(input: {
	fsaAvailable: boolean
	streamAvailable: boolean
	size: bigint
	cap?: bigint
}): DownloadStrategy {
	if (input.fsaAvailable) {
		return { kind: "fsa" }
	}

	if (input.streamAvailable) {
		return { kind: "stream" }
	}

	if (input.size > (input.cap ?? PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES)) {
		return { kind: "too-large" }
	}

	return { kind: "buffered" }
}

export type AnonPreviewability = "previewable" | "too-large" | "archive" | "unpreviewable"

// Whether the file-view auto-loads an inline preview. Video and audio stream at any size (the service
// worker's range route fed by an unauthenticated range port, or MediaSource). UNLIKE the authed drive gate
// (canPreview), an image is NOT exempt from the size cap here: an anon image is always buffered (only
// video and audio take the port-fed route), so an oversized one is capped the same as a pdf/text — the view then
// offers download instead. A non-file / undecryptable / unknown-category item is simply not
// previewable. An archive is never previewed inline: a signed-in visitor may browse it on request,
// through the authed client, at any size (its listing is not a buffered read).
export function anonPreviewability(item: DriveItem): AnonPreviewability {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return "unpreviewable"
	}

	// A `.ts` its probe still has to tell apart from TypeScript: a transport stream streams at any size.
	if (unprobedTransportStream(item)) {
		return "previewable"
	}

	const category = previewType(item)

	switch (CATEGORY_POLICY[category].anon) {
		case "none":
			return "unpreviewable"
		case "archive":
			return "archive"
		case "stream":
		case "ranged":
			return "previewable"
		case "buffer": {
			const cap = bufferedSizeCap(category, deviceProfile())

			return cap === null || base.data.size <= cap ? "previewable" : "too-large"
		}
	}
}

// The in-memory sink for a zip download with neither FSA nor the service worker route: the SDK streams the archive into `writable`, chunks
// accumulate here, and `done` resolves a single Blob once the stream closes. A zip's total size is not
// known up front, so the cap is enforced INCREMENTALLY — the moment accumulated bytes exceed it the
// stream errors, which aborts the SDK's managed future, rather than letting an unbounded archive grow
// until the tab dies. Returned as a plain object (no class) so React Compiler and the tests treat it
// as ordinary state.
export interface CollectingSink {
	writable: WritableStream<Uint8Array>
	// Awaited only once the pipe succeeds, so a failed pipe leaves its rejection handled here.
	done: Promise<Blob>
	// Whether the stream errored at the cap: the pipe then fails with the SDK's own write error, which
	// cannot tell a zip too large for this browser from any other failure.
	capExceeded: () => boolean
}

export function createCollectingSink(cap: bigint = PUBLIC_BUFFERED_DOWNLOAD_MAX_BYTES): CollectingSink {
	const chunks: Uint8Array[] = []
	let total = 0n
	let exceeded = false
	const { promise: done, resolve, reject } = Promise.withResolvers<Blob>()

	done.catch(() => undefined)

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			total += BigInt(chunk.byteLength)

			if (total > cap) {
				exceeded = true

				const error = new Error("public-link zip exceeds the in-memory download cap")

				reject(error)

				throw error
			}

			// Retained as-is: chunks arrive structured-cloned from the worker's transferred stream, so each
			// is an exact-size buffer nothing else references or reuses.
			chunks.push(chunk)
		},
		close() {
			resolve(new Blob(chunks as BlobPart[]))
		},
		abort(reason) {
			reject(reason)
		}
	})

	return { writable, done, capExceeded: () => exceeded }
}
