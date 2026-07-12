import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

// Drive → audio-engine handoff derivation. Opening (double-click) an audio file in any authed drive
// listing enqueues that folder's audio siblings in the listing's CURRENT sort order, positioned at the
// opened track, and starts the persistent player — the drive preview overlay no longer plays audio
// (previewableSiblings excludes it). This module is the PURE half: given a listing snapshot it derives
// the queue with no DOM, no worker and no store, so the whole rule is unit-testable. Deliberately does
// NOT import features/drive/lib/download (its narrowToAnyFile pulls the SDK worker in at import time,
// which would poison node tests) — it replicates that one-liner narrow locally instead.

// True when a drive item resolves to the audio preview category (extension-first, mime-fallback — the
// SAME classifier the listing icon and the preview gate use, so an item's audio-ness never disagrees
// across surfaces).
export function isAudioItem(item: DriveItem): boolean {
	return previewType(item) === "audio"
}

// Builds the playable queue track for a file item. `base.data` on the file arm is a structural superset
// of the SDK File union member, so it is assignable to AnyFile with no adapter (identical reasoning to
// features/drive/lib/download's narrowToAnyFile — replicated locally to keep this module worker-free).
// Only ever called on audio items, which are files; a directory arm is a contract violation and throws.
// Exported: the playlists module reuses this exact projection for a track it rebuilds from a stored
// PlaylistFile (via narrowItem), so a queued track's shape never diverges between the two entry points.
export function buildQueueTrack(item: DriveItem): QueueTrack {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		throw new Error("audio handoff: expected a file item")
	}

	return {
		uuid: base.data.uuid,
		name: base.data.decryptedMeta?.name ?? base.data.uuid,
		mime: base.data.decryptedMeta?.mime ?? "",
		contentType: allowedMediaContentType(item),
		file: base.data
	}
}

export interface AudioHandoff {
	tracks: QueueTrack[]
	startIndex: number
}

// Derives the queue for opening `openedUuid` from a listing snapshot, or null when the open must NOT
// hand off to the engine. Null cases (all mobile-parity):
//   - a trash listing — a trashed audio file stays non-playable, like mobile (the engine plays live
//     library audio only), so the open is inert;
//   - the opened item isn't in the snapshot or isn't audio.
// The queue is every audio sibling in listing order, positioned at the opened track. Undecryptable
// files are inherently excluded: `undecryptable` mirrors a null decrypted meta, so such a file has no
// name/mime to classify and never resolves to the audio category (isAudioItem is false) — the explicit
// skip below is belt-and-suspenders documenting that a track with no key is never enqueued.
export function deriveAudioHandoff(items: DriveItem[], openedUuid: string, isTrashVariant: boolean): AudioHandoff | null {
	if (isTrashVariant) {
		return null
	}

	const opened = items.find(item => asDirectoryOrFile(item).data.uuid === openedUuid)

	if (!opened || !isAudioItem(opened) || asDirectoryOrFile(opened).data.undecryptable) {
		return null
	}

	const playable = items.filter(item => isAudioItem(item) && !asDirectoryOrFile(item).data.undecryptable)
	const startIndex = playable.findIndex(item => asDirectoryOrFile(item).data.uuid === openedUuid)

	if (startIndex === -1) {
		return null
	}

	return { tracks: playable.map(buildQueueTrack), startIndex }
}
