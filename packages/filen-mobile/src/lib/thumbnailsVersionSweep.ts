import { THUMBNAILS_PARENT_DIRECTORY, THUMBNAILS_VERSION } from "@/lib/storageRoots"
import logger from "@/lib/logger"

// Lives outside thumbnails.ts so it can log: storageRoots.ts (where the roots are declared) cannot
// import the logger — the logger imports storageRoots for its own sink directory.
let swept = false

/**
 * Delete every non-current `thumbnails/v*` sibling. Runs once per process. Same shape as the
 * offline (offline.ts) and SDK-cache (driveSearch.ts) version sweeps.
 *
 * Without it a THUMBNAILS_VERSION bump strands the whole previous tree forever: nothing reads it,
 * and thumbnails.clear(), thumbnails.size() and sweepStrayDownloadFiles() all root at the CURRENT
 * version directory — so the bytes are invisible to the cache-size figure and unreachable from every
 * clear path.
 *
 * Safe to run while thumbnails are being generated: only the parent is listed, and the current
 * version is skipped by name, so nothing in use is touched. A tree left half-deleted by a kill or an
 * IO error wedges nothing — no reader ever visits it, and the next process retries (the once-flag is
 * in-memory). Never throws: a per-entry failure is warned and the remaining entries still go.
 */
export function sweepStaleThumbnailVersions(): void {
	if (swept) {
		return
	}

	swept = true

	try {
		if (!THUMBNAILS_PARENT_DIRECTORY.exists) {
			return
		}

		// Deletes ANY non-current entry, not just `v{N-1}`: installs that skipped a release carry more
		// than one stale tree, and nothing but the version directories is ever written here.
		for (const entry of THUMBNAILS_PARENT_DIRECTORY.list()) {
			if (entry.name === `v${THUMBNAILS_VERSION}`) {
				continue
			}

			try {
				entry.delete()
			} catch (error) {
				logger.warn("thumbnails", "failed to sweep stale thumbnail version", { error: error, name: entry.name })
			}
		}
	} catch (error) {
		logger.warn("thumbnails", "thumbnail version sweep failed", { error: error })
	}
}
