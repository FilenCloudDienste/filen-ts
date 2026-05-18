import * as FileSystem from "expo-file-system"
import { run } from "@filen/utils"
import { listLocalDirectoryRecursive } from "@/lib/fsUtils"

// Wraps the OS-managed sandbox cache directory (`FileSystem.Paths.cache`). The directory itself
// is owned by the OS and must not be deleted — we only remove its children.
//
// Other libraries (expo, react-native, third parties) may also write here; clearing wipes their
// caches too. That's intentional — the user explicitly opts in via the Advanced settings modal.
export class SandboxCache {
	private get directory(): FileSystem.Directory {
		return FileSystem.Paths.cache
	}

	public async clear(): Promise<void> {
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

					entry.delete()
				})
			})
		)
	}

	public size(): number {
		const directory = this.directory

		if (!directory.exists) {
			return 0
		}

		let total = 0

		for (const entry of listLocalDirectoryRecursive(directory)) {
			if (entry instanceof FileSystem.File) {
				total += entry.size ?? 0
			}
		}

		return total
	}
}

const sandboxCache = new SandboxCache()

export default sandboxCache
