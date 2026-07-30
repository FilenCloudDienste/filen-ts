import { useEffect, useRef, useState } from "react"
import { Buffer } from "buffer"
import { File, type FileHandle } from "expo-file-system"
import { MAX_PDF_BYTES, PDF_CUMULATIVE_READ_FACTOR } from "@/components/pdfPreview/constants"
import { checkRangeRequest, hasPdfMagic } from "@/components/pdfPreview/rangeGuard"
import { normalizeFilePathForExpo } from "@/lib/paths"
import logger from "@/lib/logger"

export type PdfSourceRefusal = "tooLarge" | "notAPdf" | "unreadable"

export type PdfSource =
	| { status: "pending" }
	| { status: "refused"; reason: PdfSourceRefusal; size: number }
	| { status: "ready"; size: number; readRange: (offset: number, length: number) => Promise<string> }

const PDF_MAGIC_LENGTH = "%PDF-".length

const PENDING: PdfSource = {
	status: "pending"
}

/**
 * Opens a local PDF for the viewer and exposes a bounded range reader for it.
 *
 * The reader is the ONLY function this component hands to the WebView, and every function prop is
 * callable by anything running inside that WebView. So it takes `(offset, length)` and nothing else —
 * never a path, which would make it an arbitrary-file-read primitive the moment a document achieved
 * script execution. It closes over one already-open handle, opened here and closed on teardown, and
 * it never reopens on demand.
 *
 * pdf.js hands its transport an END offset; the conversion to a length happens on the viewer side, so
 * exactly one place in the system knows both conventions.
 */
export default function usePdfSource(uri: string | null): PdfSource {
	const handleRef = useRef<FileHandle | null>(null)
	const bytesReadRef = useRef<number>(0)
	// Keyed by the uri it describes, so a superseded result is never shown for a newer file and no
	// synchronous "reset to pending" write is needed when the uri changes.
	const [resolved, setResolved] = useState<{ uri: string; source: PdfSource } | null>(null)

	// Keyed on `uri`, NOT useEffectOnce. The caller passes null until the file query resolves, and that
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

				// Gate before opening anything. pdf.js reserves a buffer the length of the whole file and,
				// at open, walks the page tree to the last page — which for a typical layout pulls roughly
				// one chunk per page. Refusing here is what keeps a large document from taking the WebView
				// renderer down with it.
				if (size > MAX_PDF_BYTES) {
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

				// Cheap structural check so a mislabelled file fails with an honest message instead of
				// surfacing as a pdf.js parse error.
				openHandle.offset = 0

				const magic = Buffer.from(openHandle.readBytes(Math.min(PDF_MAGIC_LENGTH, handleSize))).toString("latin1")

				if (!hasPdfMagic(magic)) {
					openHandle.close()

					openHandle = null

					setResolved({
						uri,
						source: {
							status: "refused",
							reason: "notAPdf",
							size: handleSize
						}
					})

					return
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
				const cumulativeLimit = handleSize * PDF_CUMULATIVE_READ_FACTOR

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
				logger.error("pdfPreview", "failed to open the document", {
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
	}, [uri])

	return resolved !== null && resolved.uri === uri ? resolved.source : PENDING
}
