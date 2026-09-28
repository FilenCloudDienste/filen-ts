import { useEffect, useState } from "react"
import type { PlaylistFile } from "@filen/shared"
import { useIsOnline } from "@/lib/useIsOnline"
import { playlistFileTrack } from "@/features/audio/lib/playlists"
import { trackMetadata, type TrackMetadataRequest } from "@/features/audio/lib/trackMetadata"
import type { TrackTagRecord } from "@/features/audio/lib/trackTags.logic"
import { hydrateTrackTags, useTrackTagsStore } from "@/features/audio/store/useTrackTagsStore"

// A row asks only once it has stayed on screen this long, so a fast scroll past a thousand rows reads
// none of them.
const REQUEST_SETTLE_MS = 150

export interface TrackMetadataView {
	record: TrackTagRecord | undefined
	// The row is waiting on a read that is going to happen: skeletons, not fallbacks.
	pending: boolean
	coverUrl: string | null
}

// One on-screen track's tags and cover. Asks for a read only while mounted (the table is virtualized, so
// mounted means visible), cancels a read that has not started when the row goes away, and never asks
// again for a track already known.
export function useTrackMetadata(file: PlaylistFile): TrackMetadataView {
	const record = useTrackTagsStore(state => state.byUuid[file.uuid])
	const hydrated = useTrackTagsStore(state => state.hydrated)
	const isOnline = useIsOnline()
	const [unavailableUuid, setUnavailableUuid] = useState<string | null>(null)
	const known = record !== undefined

	useEffect(() => {
		if (!hydrated) {
			void hydrateTrackTags()

			return
		}

		if (known || !isOnline) {
			return
		}

		let live = true
		let request: TrackMetadataRequest | null = null
		const timer = setTimeout(() => {
			// A verdict from before a reconnect is stale once a new read is on its way.
			setUnavailableUuid(current => (current === file.uuid ? null : current))

			request = trackMetadata.request(playlistFileTrack(file))

			void request.promise.then(outcome => {
				if (live && outcome.type === "unavailable") {
					setUnavailableUuid(file.uuid)
				}
			})
		}, REQUEST_SETTLE_MS)

		return () => {
			live = false
			clearTimeout(timer)
			request?.cancel()
		}
	}, [file, hydrated, known, isOnline])

	const coverUrl = useCoverUrl(record?.cover === true ? file : null, true)

	return {
		record,
		pending: !hydrated || (!known && isOnline && unavailableUuid !== file.uuid),
		coverUrl
	}
}

// A cover thumbnail only if one is already known and cached: never a read of the audio file. For
// artwork that decorates something else (a playlist's hero and sidebar tile).
export function useKnownCoverUrl(file: PlaylistFile | undefined): string | null {
	const hasCover = useTrackTagsStore(state => (file !== undefined ? state.byUuid[file.uuid]?.cover === true : false))

	useEffect(() => {
		void hydrateTrackTags()
	}, [])

	return useCoverUrl(hasCover && file !== undefined ? file : null, false)
}

// The cover URL for a file whose record says it has one: the in-memory URL cache, then the OPFS thumbnail
// cache, and only with `mayRefresh` a re-read of the file when the thumbnail has since been evicted.
function useCoverUrl(file: PlaylistFile | null, mayRefresh: boolean): string | null {
	const uuid = file?.uuid ?? null
	// Seeded from the URL cache at mount, so a row scrolled back into view shows its cover on the first
	// frame instead of flashing the placeholder.
	const [loaded, setLoaded] = useState<{ uuid: string; url: string } | null>(() => {
		const url = uuid !== null ? trackMetadata.peekCoverUrl(uuid) : null

		return uuid !== null && url !== null ? { uuid, url } : null
	})

	useEffect(() => {
		if (file === null) {
			return
		}

		let live = true
		let refresh: TrackMetadataRequest | null = null

		void trackMetadata.loadCoverUrl(file.uuid).then(url => {
			if (!live) {
				return
			}

			if (url !== null) {
				setLoaded({ uuid: file.uuid, url })

				return
			}

			if (!mayRefresh) {
				return
			}

			refresh = trackMetadata.request(playlistFileTrack(file), { refresh: true })

			void refresh.promise.then(() => {
				const refreshed = live ? trackMetadata.peekCoverUrl(file.uuid) : null

				if (refreshed !== null) {
					setLoaded({ uuid: file.uuid, url: refreshed })
				}
			})
		})

		return () => {
			live = false
			refresh?.cancel()
		}
	}, [file, mayRefresh])

	return uuid !== null && loaded?.uuid === uuid ? loaded.url : null
}
