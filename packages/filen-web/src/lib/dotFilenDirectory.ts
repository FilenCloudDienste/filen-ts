import type { File as SdkFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { dotFilenSubdirUuid, findDotFilenSubdir, getDotFilenSubdir, noteDotFilenFile } from "@/lib/dotFilen"
import type { SyncedFileSdk } from "@/lib/syncedDotFilenFile"

// A `.filen` subdirectory holding synced files of the user (lib/syncedDotFilenFile.ts): one directory lookup
// (memoised by dotFilen) and one listing at a time, shared by every file read from it, so a reconnect that has
// each of them read again lists the directory once.

const listings = new Map<string, { started: number; files: Promise<SdkFile[]> }>()

// The directory's files: the listing in flight when it started at or after `notBefore` (performance.now(),
// when the caller heard of a change), else a new one, which later callers then share.
export function listDotFilenDirectory(dirUuid: string, notBefore = 0): Promise<SdkFile[]> {
	const current = listings.get(dirUuid)

	if (current !== undefined && current.started >= notBefore) {
		return current.files
	}

	const listing = {
		started: performance.now(),
		files: runOp(sdkApi.listDirectory({ kind: "uuid", uuid: dirUuid })).then(result => result.files)
	}

	listings.set(dirUuid, listing)
	void listing.files
		.finally(() => {
			if (listings.get(dirUuid) === listing) {
				listings.delete(dirUuid)
			}
		})
		.catch(() => undefined)

	return listing.files
}

// Everything a synced file in `.filen/<name>` needs but its upload.
export function dotFilenDirectory(name: string): Omit<SyncedFileSdk, "upload"> {
	return {
		dir: () => getDotFilenSubdir(name),
		findDir: () => findDotFilenSubdir(name),
		knownDir: () => dotFilenSubdirUuid(name),
		noteSystemFile: noteDotFilenFile,
		listDirectory: listDotFilenDirectory,
		download: file => runOp(sdkApi.downloadFileBytes(file, crypto.randomUUID()))
	}
}
