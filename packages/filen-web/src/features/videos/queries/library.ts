import { useEffect, useSyncExternalStore } from "react"
import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { LibraryConfigDoc, Stamp } from "@filen/shared/videos"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { runOp } from "@/lib/actions/outcome"
import { noDiskPersister } from "@/queries/persist"
import {
	LIBRARY_CONFIG_QUERY_KEY,
	cachedLibraryConfig,
	fetchLibraryConfig,
	updateLibraryConfig,
	type LibraryConfigState
} from "@/features/videos/lib/library"
import { VIDEO_TITLE_DETAIL_KEY_PREFIX, videoLibrary, type VideoLibrarySnapshot } from "@/features/videos/lib/index"
import type { VideoTitleDetail } from "@/workers/videoIndex/view.logic"

// The synced library configuration. Opening the library (videoLibrary.open) is what brings it current, against the
// drive's latest event id; this reads only when that left nothing for the signed-in account.
export function useLibraryConfigQuery(): UseQueryResult<LibraryConfigState> {
	return useQuery({
		queryKey: LIBRARY_CONFIG_QUERY_KEY,
		queryFn: async () => {
			await videoLibrary.open()

			return cachedLibraryConfig() ?? fetchLibraryConfig(null)
		},
		staleTime: Infinity
	})
}

// Saves an edit of the configuration. Resolves once saved; `scanned` settles once its roots are applied to the index
// and the scans they started are done (a failure there leaves the saved roots to a retry, not to another save).
export async function editLibraryConfig(
	edit: (doc: LibraryConfigDoc, stamp: Stamp) => LibraryConfigDoc
): Promise<{ saved: LibraryConfigState; scanned: Promise<void> }> {
	const saved = await updateLibraryConfig(edit)

	return {
		saved,
		scanned: videoLibrary.configure(saved.doc).then(configured => configured.scanned)
	}
}

// As editLibraryConfig, resolving once the scans it started settled too.
export async function saveLibraryConfig(edit: (doc: LibraryConfigDoc, stamp: Stamp) => LibraryConfigDoc): Promise<LibraryConfigState> {
	const { saved, scanned } = await editLibraryConfig(edit)

	await scanned

	return saved
}

// The library's titles and roots, kept current by the index; opens the library on mount.
export function useVideoLibrary(): VideoLibrarySnapshot {
	useEffect(() => {
		videoLibrary.open().catch((e: unknown) => {
			log.warn("videos.library", "opening the library failed", e)
		})
	}, [])

	return useSyncExternalStore(videoLibrary.subscribe, videoLibrary.getSnapshot)
}

export function videoTitleDetailQueryKey(id: string) {
	return [...VIDEO_TITLE_DETAIL_KEY_PREFIX, id] as const
}

// A title's versions, seasons, episodes and extras, from the worker's classification (no request). Refetched when
// the title changes in the index.
export function useVideoTitleDetailQuery(id: string): UseQueryResult<VideoTitleDetail | null> {
	return useQuery({
		queryKey: videoTitleDetailQueryKey(id),
		queryFn: () => runOp<VideoTitleDetail | null>(sdkApi.videoTitleDetail(id)),
		staleTime: Infinity,
		persister: noDiskPersister
	})
}
