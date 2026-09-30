import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import logger from "@/lib/logger"
import { ensureDirectory } from "@/lib/fsUtils"

// Filen-owned temporary files live under FileSystem.Paths.cache/filen-tmp/ so the
// sandbox-cache clear action (which wipes other-libs' detritus from Paths.cache) can
// skip them, preventing in-flight transfers/uploads/exports from losing their staging.
// Orphans from crashed sessions are swept by sweepTmpDir() via the Settings → Advanced
// "Clean up temporary files" action (gated on the transfers/sync stores).
export const TMP_DIR_NAME = "filen-tmp"

const directory = new FileSystem.Directory(FileSystem.Paths.join(FileSystem.Paths.cache, TMP_DIR_NAME))

function ensure(): FileSystem.Directory {
	ensureDirectory(directory)

	return directory
}

export function tmpDir(): FileSystem.Directory {
	return ensure()
}

// Returns a fresh FileSystem.File handle inside the filen-tmp directory. The file
// is NOT created on disk — the caller is responsible for writing/moving content.
// Pass a custom name (e.g., a sanitized export filename); defaults to a random uuid.
export function newTmpFile(name?: string): FileSystem.File {
	return new FileSystem.File(FileSystem.Paths.join(ensure().uri, name ?? randomUUID()))
}

// Writes `data` to filen-tmp/`name` (replacing a leftover of the same name) and pairs the file with
// the cleanup shareTmpFile runs after the share sheet closes.
export function writeTmpFile(name: string, data: string | Uint8Array): { file: FileSystem.File; cleanup: () => void } {
	const file = newTmpFile(name)

	if (file.exists) {
		file.delete()
	}

	file.write(data)

	return {
		file,
		cleanup: () => {
			if (file.exists) {
				file.delete()
			}
		}
	}
}

// Returns a fresh FileSystem.Directory handle inside the filen-tmp directory. The
// directory is NOT created on disk — the caller is responsible for creating it
// before writing children. Pass a custom name; defaults to a random uuid.
export function newTmpDir(name?: string): FileSystem.Directory {
	return new FileSystem.Directory(FileSystem.Paths.join(ensure().uri, name ?? randomUUID()))
}

// Returns a File handle named `name` inside a fresh, created uuid directory under filen-tmp,
// ready to be written/downloaded to. The caller owns deleting the parent directory.
export function newTmpStagedFile(name: string): FileSystem.File {
	const dir = newTmpDir()

	dir.create({
		intermediates: true,
		idempotent: true
	})

	return new FileSystem.File(FileSystem.Paths.join(dir.uri, name))
}

// Wipes every entry under filen-tmp/. Safe to call only when no transfers/uploads/
// exports can be in flight — the Settings → Advanced action that invokes this gates
// on the transfers and sync stores. Best-effort; failures are swallowed so an
// unreadable orphan doesn't block the others.
export function sweepTmpDir(): void {
	if (!directory.exists) {
		return
	}

	try {
		directory.delete()
	} catch (e) {
		logger.warn("tmp", "sweepTmpDir delete failed", { error: e })
	}

	ensureDirectory(directory)
}
