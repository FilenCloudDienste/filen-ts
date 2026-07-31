import { useRef } from "react"
import { Buffer } from "buffer"
import { File, FileMode, type FileHandle } from "expo-file-system"
import { MAX_PDF_BYTES, PDF_MAX_RANGE_LENGTH } from "@/components/pdfPreview/constants"
import { newTmpFile } from "@/lib/tmp"

export type PdfSaveTarget = {
	/** WebView-callable. Appends one chunk of the serialised document. */
	writeChunk: (chunk: string) => Promise<void>
	/** Opens a fresh temp file and arms the writer. Returns the file it will fill. */
	begin: () => File
	/** Disarms the writer and returns the completed file, or null if nothing valid was written. */
	finish: () => File | null
	/** Disarms and deletes whatever was written. */
	discard: () => void
}

/**
 * Receives a saved document from the viewer.
 *
 * The mirror of the range reader, and bounded for the same reason: this is a function prop, so
 * anything running in the WebView can call it. It writes only to a temp file this side created —
 * never a path from the WebView — and only while a save the user asked for is in flight. Outside
 * that window it rejects, so a document cannot write at a time of its own choosing.
 *
 * The document is streamed rather than handed over whole because `saveDocument()` returns the entire
 * file, and a large one crossing the bridge as a single base64 string is the case the reader was
 * designed to avoid.
 */
export default function usePdfSaveTarget(): PdfSaveTarget {
	const handleRef = useRef<FileHandle | null>(null)
	const fileRef = useRef<File | null>(null)
	const writtenRef = useRef<number>(0)

	const close = () => {
		handleRef.current?.close()
		handleRef.current = null
	}

	return {
		writeChunk: async (chunk: string) => {
			const handle = handleRef.current

			if (!handle) {
				throw new Error("no save in progress")
			}

			if (typeof chunk !== "string" || chunk.length === 0) {
				throw new Error("chunk must be a non-empty string")
			}

			const bytes = Buffer.from(chunk, "base64")

			if (bytes.byteLength === 0 || bytes.byteLength > PDF_MAX_RANGE_LENGTH) {
				throw new Error("chunk out of bounds")
			}

			// A save cannot legitimately exceed what the viewer was allowed to open, plus the incremental
			// update appended to it.
			if (writtenRef.current + bytes.byteLength > MAX_PDF_BYTES) {
				throw new Error("save exceeds the size limit")
			}

			handle.writeBytes(new Uint8Array(bytes))

			writtenRef.current += bytes.byteLength
		},
		begin: () => {
			close()

			const file = newTmpFile("pdfSave.pdf")

			file.create({
				overwrite: true
			})

			fileRef.current = file
			writtenRef.current = 0
			handleRef.current = file.open(FileMode.WriteOnly)

			return file
		},
		finish: () => {
			close()

			const file = fileRef.current

			fileRef.current = null

			if (!file || writtenRef.current === 0 || !file.exists) {
				return null
			}

			// Structural check before this is handed to an upload: the viewer is the untrusted side, and
			// what it streamed back is about to replace the user's file.
			const magic = Buffer.from(new File(file.uri).open().readBytes(5)).toString("latin1")

			if (magic !== "%PDF-") {
				file.delete()

				return null
			}

			return file
		},
		discard: () => {
			close()

			const file = fileRef.current

			fileRef.current = null
			writtenRef.current = 0

			if (file?.exists) {
				file.delete()
			}
		}
	}
}
