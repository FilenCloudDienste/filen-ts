import { type QueueItem } from "@/features/audio/audio"
import { driveItemDisplayName } from "@/lib/decryption"

export type AudioTrackLabels = {
	titleLabel: string
	artistLabel: string
}

/**
 * Resolves the display labels for the audio floating-bar and PlaylistToolbar.
 *
 * Invariant: only call `t("not_playing")` when there is genuinely no active track
 * (`queueItem === null`). While metadata is still loading for an active track, show
 * the file's decrypted name (or `unknownTitle`) rather than "not playing".
 *
 * @param queueItem        - The currently active queue item, or null when idle / transitioning.
 * @param metadataLoaded   - Whether `audioMetadataQuery.status === "success"`.
 * @param metadataTitle    - The resolved ID3 title from a successful metadata query.
 * @param metadataArtist   - The resolved ID3 artist from a successful metadata query.
 * @param labels           - Translated fallback strings from `useTranslation`.
 */
export function resolveAudioTrackLabels(
	queueItem: QueueItem | null,
	metadataLoaded: boolean,
	metadataTitle: string | null | undefined,
	metadataArtist: string | null | undefined,
	labels: {
		notPlaying: string
		unknownTitle: string
		unknownArtist: string
	}
): AudioTrackLabels {
	if (!queueItem) {
		return { titleLabel: labels.notPlaying, artistLabel: labels.notPlaying }
	}

	if (metadataLoaded) {
		const titleLabel = queueItem.item.data.undecryptable
			? driveItemDisplayName(queueItem.item)
			: (metadataTitle ?? queueItem.item.data.decryptedMeta?.name ?? labels.unknownTitle)

		return {
			titleLabel,
			artistLabel: metadataArtist ?? labels.unknownArtist
		}
	}

	// Metadata is still loading but a track is active: show the file name (or a
	// neutral placeholder) instead of the misleading "not playing" copy.
	const titleLabel = queueItem.item.data.undecryptable
		? driveItemDisplayName(queueItem.item)
		: (queueItem.item.data.decryptedMeta?.name ?? labels.unknownTitle)

	return {
		titleLabel,
		artistLabel: labels.unknownArtist
	}
}
