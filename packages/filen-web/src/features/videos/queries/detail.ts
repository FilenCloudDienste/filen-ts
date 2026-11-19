import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { decidePlayback, type VideoProbe } from "@filen/shared/videos"
import { type } from "arktype"
import { noDiskPersister } from "@/queries/persist"
import { queryClient } from "@/queries/client"
import { playbackCapabilities } from "@/lib/media/playback/capabilities"
import { streamFacts, toLadderProbe } from "@/lib/media/playback/capabilities.logic"
import { videoLibrary } from "@/features/videos/lib/index"
import { probeService } from "@/features/videos/lib/probeService"
import { PROBE_RANK } from "@/features/videos/lib/probeService.logic"
import { probeRecords } from "@/features/videos/lib/records"
import { readNfo, type NfoSummary } from "@/features/videos/lib/nfoReader"
import { ladderBadge, type LadderBadge } from "@/features/videos/lib/titleDetail.logic"
import { defaultAudioIndex } from "@/features/videos/lib/player/audioChoice.logic"
import type { VideoFileRef, VideoPartView } from "@/workers/videoIndex/view.logic"

// What the detail pages read beyond the index: the chosen version's full probe (explicit, one per file), stored
// probes of the other versions (local), the NFO (one read per file, kept in kv), and the season last viewed.

// The full probe of the part about to be played; null when none can be had (offline, unreadable, gone). A null is
// stale at once, so the next mount, focus or reconnect asks again (a stored verdict answers from memory or kv).
export function useDetailProbeQuery(part: VideoPartView | null): UseQueryResult<VideoProbe | null> {
	const ref = part?.file ?? null

	return useQuery({
		queryKey: ["videos", "detailProbe", ref?.uuid ?? ""] as const,
		queryFn: async ({ signal }) => {
			if (ref === null) {
				return null
			}

			const [file] = await videoLibrary.playableFiles([ref.stableUuid])

			if (file === undefined) {
				return null
			}

			const record = await probeService.request({ uuid: file.uuid, file }, "full", { rank: () => PROBE_RANK.explicit, signal })

			return record?.probe ?? null
		},
		enabled: part !== null && !part.unsupported,
		staleTime: query => (query.state.data === null ? 0 : Infinity),
		persister: noDiskPersister
	})
}

// Probes already stored for these files (kv reads only; nothing is probed), by uuid.
export function useStoredProbesQuery(uuids: readonly string[]): UseQueryResult<ReadonlyMap<string, VideoProbe>> {
	return useQuery({
		queryKey: ["videos", "storedProbes", uuids.join(",")] as const,
		queryFn: async () => {
			const records = await Promise.all(uuids.map(uuid => probeRecords.get(uuid)))
			const out = new Map<string, VideoProbe>()

			uuids.forEach((uuid, index) => {
				const probe = records[index]?.probe

				if (probe !== undefined && probe !== null) {
					out.set(uuid, probe)
				}
			})

			return out
		},
		enabled: uuids.length > 0,
		staleTime: 0,
		persister: noDiskPersister
	})
}

// Direct or Remux per file, for the files whose probe is known; the browser's decoder answers are kept per session.
// Each file is judged with the audio track the player would start on (defaultAudioIndex), so the badge and the
// player agree.
export function useLadderBadgesQuery(
	files: readonly { uuid: string; size: number; probe: VideoProbe }[],
	rememberedLang: string | null
): UseQueryResult<ReadonlyMap<string, LadderBadge>> {
	return useQuery({
		queryKey: ["videos", "ladderBadges", files.map(file => file.uuid).join(","), rememberedLang ?? ""] as const,
		queryFn: async () => {
			const out = new Map<string, LadderBadge>()

			await Promise.all(
				files.map(async ({ uuid, size, probe }) => {
					const ladderProbe = toLadderProbe(probe)
					const audioIndex = defaultAudioIndex({
						probe,
						rememberedLang,
						userLanguages: typeof navigator === "undefined" ? [] : navigator.languages
					})
					const selection = { audioIndex, subtitle: "none" as const }
					const caps = await playbackCapabilities.capabilities(ladderProbe, selection, streamFacts({ probe, selection, size }))

					out.set(uuid, ladderBadge(decidePlayback(ladderProbe, selection, caps).path))
				})
			)

			return out
		},
		enabled: files.length > 0,
		staleTime: Infinity,
		persister: noDiskPersister
	})
}

// The NFO's summary; `enabled` gates the read (a row still off screen asks for nothing).
export function useNfoQuery(ref: VideoFileRef | null, enabled = true): UseQueryResult<NfoSummary | null> {
	return useQuery({
		queryKey: ["videos", "nfo", ref?.uuid ?? ""] as const,
		queryFn: () => (ref === null ? null : readNfo(ref)),
		enabled: enabled && ref !== null,
		staleTime: Infinity,
		retry: false,
		persister: noDiskPersister
	})
}

const SEASON_KV_PREFIX = "videos.v1.season."
const seasonSchema = type("number.integer >= 0")

function lastSeasonKey(seriesId: string) {
	return ["videos", "lastSeason", seriesId] as const
}

// The season last opened on a series page (this device).
export function useLastSeasonQuery(seriesId: string): UseQueryResult<number | null> {
	return useQuery({
		queryKey: lastSeasonKey(seriesId),
		queryFn: async () => (await kvGetJson(`${SEASON_KV_PREFIX}${seriesId}`, seasonSchema).catch(() => null)) ?? null,
		staleTime: Infinity,
		persister: noDiskPersister
	})
}

export function rememberSeason(seriesId: string, season: number): void {
	queryClient.setQueryData(lastSeasonKey(seriesId), season)
	void kvSetJson(`${SEASON_KV_PREFIX}${seriesId}`, season).catch(() => undefined)
}
