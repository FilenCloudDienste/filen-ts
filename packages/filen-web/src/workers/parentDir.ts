import type { AnyNormalDir, Dir } from "@filen/sdk-rs"
import { isUuid } from "@filen/shared"
import { cacheFoundDir, getCachedDir, isFoundDir } from "@/features/drive/lib/cache"
import { isUuidStr } from "@/lib/uuidStr"

// A directory findDirUuid found under `parent`.
export function noteFoundDir(uuid: string, parent: string): void {
	if (isUuid(uuid)) {
		cacheFoundDir(uuid, parent)
	}
}

// A directory as the parent of a listing, create, upload, copy or move. The SDK reads only a parent's uuid there, so
// a found directory passes as a uuid-only Root with no getDir; a cached Dir is used when held. Where the directory
// itself is the subject (move, trash, rename, size) a full Dir is still required.
export async function resolveParentDir(
	uuid: string,
	lookup: (uuid: string) => Promise<Dir | undefined>
): Promise<AnyNormalDir | undefined> {
	const cached = getCachedDir(uuid)

	if (cached !== undefined) {
		return cached
	}

	return isFoundDir(uuid) && isUuidStr(uuid) ? { uuid } : await lookup(uuid)
}
