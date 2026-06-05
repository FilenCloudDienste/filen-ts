import * as FileSystem from "expo-file-system"
import { run } from "@filen/utils"
import { walkLocalDirectory } from "@/lib/fsUtils"
import { TMP_DIR_NAME } from "@/lib/tmp"

// Wraps the OS-managed sandbox cache directory (`FileSystem.Paths.cache`). The directory itself
// is owned by the OS and must not be deleted — we only remove its children.
//
// The filen-tmp/ subdirectory is excluded from both clear() and size(): it holds in-flight
// staging files (uploads, exports, share-sheet payloads, atomic writes). Wiping it mid-transfer
// would corrupt active operations. Orphans from crashed sessions are swept at app launch via
// sweepTmpDir() in lib/tmp.ts.
//
// Other libraries (expo, react-native, third parties) may also write here; clearing wipes their
// caches too. That's intentional — the user explicitly opts in via the Advanced settings modal.
export const sandboxCache = {
	get directory(): FileSystem.Directory {
		return FileSystem.Paths.cache
	},

	async clear(): Promise<void> {
		const directory = this.directory

		if (!directory.exists) {
			return
		}

		let entries: (FileSystem.File | FileSystem.Directory)[]

		try {
			entries = directory.list()
		} catch {
			return
		}

		await Promise.all(
			entries.map(async entry => {
				await run(async () => {
					if (!entry.exists) {
						return
					}

					if (entry instanceof FileSystem.Directory && FileSystem.Paths.basename(entry.uri) === TMP_DIR_NAME) {
						return
					}

					entry.delete()
				})
			})
		)
	},

	size(): number {
		const directory = this.directory

		if (!directory.exists) {
			return 0
		}

		let total = 0

		walkLocalDirectory(directory, entry => {
			if (entry instanceof FileSystem.Directory && FileSystem.Paths.basename(entry.uri) === TMP_DIR_NAME) {
				return "skip"
			}

			if (entry instanceof FileSystem.File) {
				total += entry.size ?? 0
			}

			return undefined
		})

		return total
	}
}

export default sandboxCache
