import { useEffect, useRef, useState } from "react"
import { Buffer } from "buffer"
import { File, type FileHandle } from "expo-file-system"
import { CUMULATIVE_READ_FACTOR, checkRangeRequest, hasMagic, type RangeReader } from "@/lib/rangeTransfer"
import { normalizeFilePathForExpo } from "@/lib/paths"
import logger from "@/lib/logger"

export type RangeSourceRefusal = "tooLarge" | "wrongFormat" | "unreadable"

export type RangeSource =
	| { status: "pending" }
	| { status: "refused"; reason: RangeSourceRefusal; size: number }
	| { status: "ready"; size: number; readRange: RangeReader }

const PENDING: RangeSource = {
	status: "pending"
}

/**
 * Opens a local file for a DOM-component viewer and exposes a bounded range reader for it.
 *
 * The reader is the ONLY function handed to the WebView, and every function prop is callable by
 * anything running inside it. So it takes `(offset, length)` and nothing else — never a path, which
 * would make it an arbitrary-file-read primitive the moment a document achieved script execution. It
 * closes over one already-open handle, opened here and closed on teardown, and never reopens on
 * demand.
 *
 * @param uri Local file to open, or null while the caller is still resolving one.
 * @param maxBytes Largest file this viewer will open. The real memory protection — refusing here is
 *   what keeps a large document from taking the WebView renderer down with it — so it is a required
 *   decision per viewer rather than a shared default.
 * @param magic Expected leading bytes, when the format has a signature worth checking.
 */
export default function useRangeSource(
	uri: string | null,
	{
		maxBytes,
		magic
	}: {
		maxBytes: number
		magic?: string
	}
): RangeSource {
	const handleRef = useRef<FileHandle | null>(null)
	const bytesReadRef = useRef<number>(0)
	// Keyed by the uri it describes, so a superseded result is never shown for a newer file and no
	// synchronous "reset to pending" write is needed when the uri changes.
	const [resolved, setResolved] = useState<{ uri: string; source: RangeSource } | null>(null)

	// Keyed on `uri`, NOT useEffectOnce. The caller passes null until its file query resolves, and that
	// query is always pending at mount (gcTime: 0, no prefetch), so a mount-only effect would capture
	// null, early-return and never run again — leaving the viewer on a spinner forever for every
	// document. useEffectOnce documents this exact hazard.
	useEffect(() => {
		if (uri === null) {
			return
		}

		let openHandle: FileHandle | null = null
		let cancelled = false

		const open = async () => {
			// Yield once before touching the filesystem: opening a handle and reading a header
			// synchronously inside React's commit blocks the JS thread at exactly the moment the preview
			// is trying to appear.
			await Promise.resolve()

			if (cancelled) {
				return
			}

			try {
				const file = new File(normalizeFilePathForExpo(uri))
				const size = file.size ?? 0

				// Gate before opening anything.
				if (size > maxBytes) {
					setResolved({
						uri,
						source: {
							status: "refused",
							reason: "tooLarge",
							size
						}
					})

					return
				}

				openHandle = file.open()

				const handleSize = openHandle.size ?? size

				// Re-check against the authority. The gate above reads file metadata, which this file
				// distrusts everywhere else — and it is the one check documented as the real memory
				// protection, so it must not be the one place that trusts a stale stat.
				if (handleSize > maxBytes) {
					openHandle.close()

					openHandle = null

					setResolved({
						uri,
						source: {
							status: "refused",
							reason: "tooLarge",
							size: handleSize
						}
					})

					return
				}

				// Cheap structural check so a mislabelled file fails with an honest message instead of
				// surfacing as a parse error from inside the rendering library.
				if (magic !== undefined) {
					openHandle.offset = 0

					const header = Buffer.from(openHandle.readBytes(Math.min(magic.length, handleSize))).toString("latin1")

					if (!hasMagic(header, magic)) {
						openHandle.close()

						openHandle = null

						setResolved({
							uri,
							source: {
								status: "refused",
								reason: "wrongFormat",
								size: handleSize
							}
						})

						return
					}
				}

				if (cancelled) {
					openHandle.close()

					openHandle = null

					return
				}

				handleRef.current = openHandle
				bytesReadRef.current = 0

				// The size authority is the handle, never file metadata: metadata can disagree with what
				// is on disk, and a length derived from it would let a read run past the end.
				const cumulativeLimit = handleSize * CUMULATIVE_READ_FACTOR

				setResolved({
					uri,
					source: {
						status: "ready",
						size: handleSize,
						readRange: async (offset: number, length: number) => {
							const handle = handleRef.current

							if (!handle) {
								throw new Error("range reader used after teardown")
							}

							const rejection = checkRangeRequest({
								offset,
								length,
								size: handleSize,
								bytesRead: bytesReadRef.current,
								cumulativeLimit
							})

							if (rejection !== null) {
								throw new Error(`range request refused: ${rejection}`)
							}

							handle.offset = offset

							const bytes = handle.readBytes(length)

							if (bytes.byteLength !== length) {
								throw new Error("short read")
							}

							bytesReadRef.current += bytes.byteLength

							return Buffer.from(bytes).toString("base64")
						}
					}
				})
			} catch (e) {
				logger.error("rangeSource", "failed to open a file for preview", {
					error: e
				})

				// Nulled after closing: the cleanup below would otherwise close the same handle a second
				// time, and on iOS that throws — turning a handled failure into an exception raised during
				// React's unmount.
				openHandle?.close()

				openHandle = null

				setResolved({
					uri,
					source: {
						status: "refused",
						reason: "unreadable",
						size: 0
					}
				})
			}
		}

		open()

		return () => {
			cancelled = true
			handleRef.current = null

			openHandle?.close()

			openHandle = null
		}
	}, [uri, maxBytes, magic])

	return resolved !== null && resolved.uri === uri ? resolved.source : PENDING
}
