import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { newTmpFile } from "@/lib/tmp"
import { AnyDirWithContext, AnyDirWithContext_Tags, AnySharedDir_Tags, AnyNormalDir_Tags, AnyLinkedDir_Tags } from "@filen/sdk-rs"

// "sharedInRoot" means the item lives at the top level of Shared In (no parent dir, just the shared root listing).
export type OfflineParent = AnyDirWithContext | "sharedInRoot"

/**
 * Write data to a file atomically using write-to-temp-then-move.
 * Prevents corruption from crashes mid-write.
 */
export function atomicWrite(file: FileSystem.File, data: string | Uint8Array): FileSystem.File {
	const tmp = newTmpFile(`.tmp-${randomUUID()}`)

	tmp.write(data)

	try {
		if (file.exists) {
			file.delete()
		}

		tmp.moveSync(file)

		return file
	} catch (e) {
		if (tmp.exists) {
			tmp.delete()
		}

		throw e
	}
}

// Produces a stable string key from the deeply-nested AnyDirWithContext tagged union.
// Used to dedup parent listings in sync() and for the listDirectories cache.
export function parentCacheKey(parent: OfflineParent): string {
	if (typeof parent === "string") {
		return parent
	}

	switch (parent.tag) {
		case AnyDirWithContext_Tags.Normal: {
			switch (parent.inner[0].tag) {
				case AnyNormalDir_Tags.Dir: {
					return `dir:${parent.inner[0].inner[0].uuid}`
				}

				case AnyNormalDir_Tags.Root: {
					return `root:${parent.inner[0].inner[0].uuid}`
				}

				default: {
					throw new Error("Unknown AnyNormalDir tag")
				}
			}
		}

		case AnyDirWithContext_Tags.Shared: {
			switch (parent.inner[0].dir.tag) {
				case AnySharedDir_Tags.Dir: {
					return `shared-dir:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				case AnySharedDir_Tags.Root: {
					return `shared-root:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				default: {
					throw new Error("Unknown AnySharedDir tag")
				}
			}
		}

		case AnyDirWithContext_Tags.Linked: {
			switch (parent.inner[0].dir.tag) {
				case AnyLinkedDir_Tags.Dir: {
					return `linked-dir:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				case AnyLinkedDir_Tags.Root: {
					return `linked-root:${parent.inner[0].dir.inner[0].inner.uuid}`
				}

				default: {
					throw new Error("Unknown AnyLinkedDir tag")
				}
			}
		}

		default: {
			throw new Error("Unknown AnyDirWithContext tag")
		}
	}
}
