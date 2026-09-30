import { useTranslation } from "react-i18next"
import { type QueueItem } from "@/features/audio/audio"
import useAudioMetadataQuery from "@/features/audio/queries/useAudioMetadata.query"
import { resolveAudioTrackLabels } from "@/features/audio/utils"

export function useNowPlayingDisplay(queueItem: QueueItem | null) {
	const { t } = useTranslation()

	const audioMetadataQuery = useAudioMetadataQuery(
		{
			type: "drive",
			data: {
				uuid: queueItem?.item.data.uuid ?? "",
				// By-value so a cross-directory search hit resolves its metadata.
				item: queueItem?.item
			}
		},
		{
			enabled: !!queueItem
		}
	)

	const { titleLabel, artistLabel } = resolveAudioTrackLabels(
		queueItem,
		audioMetadataQuery.status === "success",
		audioMetadataQuery.data?.title,
		audioMetadataQuery.data?.artist,
		{
			notPlaying: t("not_playing"),
			unknownTitle: t("unknown_title"),
			unknownArtist: t("unknown_artist")
		}
	)

	return {
		pictureUri: queueItem && audioMetadataQuery.status === "success" ? audioMetadataQuery.data?.pictureUri : null,
		titleLabel,
		artistLabel
	}
}

export default useNowPlayingDisplay
