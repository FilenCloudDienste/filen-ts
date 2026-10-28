import type { File as SdkFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"

// `.filen/videos` holds both the library configuration and the watch state: the latest listing of it this session and
// when it started (performance.now()), so a reader that needs the directory as it was at some moment or later takes a
// listing started since instead of listing again.
let latest: { dirUuid: string; startedAt: number; files: Promise<SdkFile[]> } | null = null

// The directory's files as listed at `startedAfter` or later: a listing of this session that started since (done or
// still out), else a new one.
export function listVideosDir(dirUuid: string, startedAfter: number): Promise<SdkFile[]> {
	const known = latest

	if (known?.dirUuid === dirUuid && known.startedAt >= startedAfter) {
		return known.files
	}

	const entry = {
		dirUuid,
		startedAt: performance.now(),
		files: runOp(sdkApi.listDirectory({ kind: "uuid", uuid: dirUuid })).then(listing => listing.files)
	}

	latest = entry
	void entry.files.catch(() => {
		if (latest === entry) {
			latest = null
		}
	})

	return entry.files
}

// Logout: nothing of the signed-out account's drive is reused.
export function forgetVideosDirListing(): void {
	latest = null
}
