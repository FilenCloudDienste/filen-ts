import { useEffect, useRef, useState } from "react"
import { Buffer } from "buffer"
import { File, FileMode, type FileHandle } from "expo-file-system"
import { MAX_RANGE_LENGTH, hasMagic, type ChunkWriter } from "@/lib/rangeTransfer"
import { newTmpFile } from "@/lib/tmp"

export type ChunkedWriteTarget = {
	/** WebView-callable. Appends one base64 chunk of the document being saved. */
	writeChunk: ChunkWriter
	/** Opens a fresh temp file and arms the writer. Returns the file it will fill. */
	begin: () => File
	/** Disarms the writer and returns the completed file, or null if nothing valid was written. */
	finish: () => File | null
	/** Disarms and deletes whatever was written. */
	discard: () => void
}

/**
 * Receives a saved document from a DOM-component viewer.
 *
 * The mirror of the range reader, and bounded for the same reason: this is a function prop, so
 * anything running in the WebView can call it. It writes only to a temp file this side created —
 * never a path from the WebView — and only while a save the user asked for is in flight. Outside
 * that window it rejects, so a document cannot write at a time of its own choosing.
 *
 * The document is streamed rather than handed over whole because an editor's serialised output is
 * the whole file, and a large one crossing the bridge as a single base64 string is the case the
 * reader was designed to avoid.
 *
 * @param maxBytes Ceiling on the assembled document. A save cannot legitimately exceed what the
 *   viewer was allowed to open, plus whatever the edit appended to it.
 * @param magic Expected leading bytes of the result, when the format has a signature. A structural
 *   check before this is handed to an upload: the viewer is the untrusted side, and what it streamed
 *   back is about to replace the user's file.
 * @param fileName Name for the temp file; only affects the staging path.
 */
export default function useChunkedWriteTarget(config: { maxBytes: number; magic?: string; fileName: string }): ChunkedWriteTarget {
	const handleRef = useRef<FileHandle | null>(null)
	const fileRef = useRef<File | null>(null)
	const writtenRef = useRef<number>(0)
	// Latest config, so the object below can be built once without capturing a stale bound.
	const configRef = useRef(config)

	useEffect(() => {
		configRef.current = config
	})

	const close = () => {
		handleRef.current?.close()
		handleRef.current = null
	}

	// Built ONCE. Consumers hold this in effect dependencies to arm and disarm a save, so a fresh
	// object per render would run that effect's cleanup — discarding the temp file — in the middle of
	// the save that a re-render was reporting.
	return useState<ChunkedWriteTarget>(() => ({
		writeChunk: async (chunk: string) => {
			const handle = handleRef.current

			if (!handle) {
				throw new Error("no save in progress")
			}

			if (typeof chunk !== "string" || chunk.length === 0) {
				throw new Error("chunk must be a non-empty string")
			}

			const bytes = Buffer.from(chunk, "base64")

			if (bytes.byteLength === 0 || bytes.byteLength > MAX_RANGE_LENGTH) {
				throw new Error("chunk out of bounds")
			}

			if (writtenRef.current + bytes.byteLength > configRef.current.maxBytes) {
				throw new Error("save exceeds the size limit")
			}

			handle.writeBytes(new Uint8Array(bytes))

			writtenRef.current += bytes.byteLength
		},
		begin: () => {
			close()

			const file = newTmpFile(configRef.current.fileName)

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

			// `begin()` having run is the test for a save being in progress, NOT the byte count: emptying
			// a text file and saving it is a legitimate edit, and a zero-length result is the correct
			// output for it. A format that cannot be empty is rejected by its magic check below instead.
			if (!file || !file.exists) {
				return null
			}

			const magic = configRef.current.magic

			if (magic !== undefined) {
				const readHandle = new File(file.uri).open()

				try {
					if (!hasMagic(Buffer.from(readHandle.readBytes(magic.length)).toString("latin1"), magic)) {
						file.delete()

						return null
					}
				} catch {
					file.delete()

					return null
				} finally {
					readHandle.close()
				}
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
	}))[0]
}
