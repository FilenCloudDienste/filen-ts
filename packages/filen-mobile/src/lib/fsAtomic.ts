import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { newTmpFile } from "@/lib/tmp"
import logger from "@/lib/logger"

/**
 * Write data to a file via write-to-temp-then-overwriting-move.
 *
 * NOT crash-atomic, despite the name (kept for call-site stability). expo-file-system v56
 * implements an overwriting move as delete-destination-THEN-move-source on BOTH platforms — iOS
 * `FileSystemPath.move` does `removeItem(dest)` then `moveItem(src)`; Android `CopyMoveStrategy`
 * `deleteRecursively(dest)` in `prepareAsDestination` then `renameTo`/`Files.move`. There is no
 * single atomic-replace primitive exposed, so a crash / OS-kill (common for iOS background tasks) in
 * the window between the delete and the move can leave the destination MISSING entirely.
 *
 * What it DOES guarantee: the destination is never left holding a PARTIAL write (the temp is written
 * in full before the move), and a failed move deletes the temp. Durability across a crash relies on
 * the CONSUMER self-healing a missing destination — the offline index is rebuilt from the per-dir
 * metas (`updateIndex`), a missing tree `.filenmeta` is repaired by `healBrokenTrees`, and
 * fileCache/audioCache rebuild their index by re-listing. A genuinely atomic replace would need a
 * native shim (iOS `replaceItemAt`, Android `Files.move(..., ATOMIC_MOVE)`) — deferred by decision
 * (the consumers self-heal; see OF-03).
 *
 * Lives in lib (not a feature) because it is shared infrastructure: offline storage, the file cache,
 * and the audio metadata cache all write their on-disk indexes/sidecars through it.
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
