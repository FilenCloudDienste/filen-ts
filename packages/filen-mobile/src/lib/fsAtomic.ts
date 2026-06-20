import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { newTmpFile } from "@/lib/tmp"
import logger from "@/lib/logger"

/**
 * Write data to a file atomically using write-to-temp-then-move.
 * Prevents corruption from crashes mid-write: the destination is replaced by a SINGLE
 * overwriting move (expo-file-system v56 `moveSync` honors RelocationOptions `overwrite`
 * natively on both platforms) — never a delete-then-move pair, which had a window where
 * a crash between the two steps left the destination missing entirely.
 *
 * Lives in lib (not a feature) because it is shared infrastructure: offline storage,
 * the file cache, and the audio metadata cache all write their on-disk indexes/sidecars
 * through it.
 */
export function atomicWrite(file: FileSystem.File, data: string | Uint8Array): FileSystem.File {
	const tmp = newTmpFile(`.tmp-${randomUUID()}`)

	tmp.write(data)

	try {
		tmp.moveSync(file, {
			overwrite: true
		})

		return file
	} catch (e) {
		if (tmp.exists) {
			tmp.delete()
		}

		logger.error("fsAtomic", "atomicWrite moveSync failed", { dest: file.uri, error: e })

		throw e
	}
}
