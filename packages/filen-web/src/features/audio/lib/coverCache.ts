import type { TrackPicture } from "@/features/audio/lib/metadata"

// A small LRU of recently-seen cover-art blob URLs, keyed by track uuid. Owned by the audio engine
// (never a component) so every surface that shows cover art — the player bar, the now-playing panel's
// queue thumbnails, MediaSession artwork — shares exactly one mint per track, with revoke-on-evict and
// revoke-all-on-logout discipline (mirrors mediaViewer.tsx's blob lifecycle, scaled to a small bounded
// set instead of a single current item). Metadata extraction only ever runs for the current + one-ahead
// prefetched track (never a bulk scan), so this cap is generous headroom for a short listening
// back/forward history, not a real memory concern.
export const COVER_CACHE_MAX_ENTRIES = 8

export interface ObjectUrlFns {
	createObjectUrl: (blob: Blob) => string
	revokeObjectUrl: (url: string) => void
}

const defaultObjectUrlFns: ObjectUrlFns = {
	createObjectUrl: blob => URL.createObjectURL(blob),
	revokeObjectUrl: url => {
		URL.revokeObjectURL(url)
	}
}

export class CoverArtCache {
	private readonly urls = new Map<string, string>()
	private readonly fns: ObjectUrlFns

	public constructor(fns: ObjectUrlFns = defaultObjectUrlFns) {
		this.fns = fns
	}

	// Mints (or re-mints) the blob URL for `uuid`'s embedded picture, moving it to the most-recently-used
	// position and evicting the oldest entry once the cap is exceeded. Returns the live URL.
	public set(uuid: string, picture: TrackPicture): string {
		const existing = this.urls.get(uuid)

		if (existing !== undefined) {
			this.fns.revokeObjectUrl(existing)
			this.urls.delete(uuid)
		}

		const url = this.fns.createObjectUrl(new Blob([picture.data as Uint8Array<ArrayBuffer>], { type: picture.format }))

		this.urls.set(uuid, url)

		while (this.urls.size > COVER_CACHE_MAX_ENTRIES) {
			const oldestKey: string | undefined = this.urls.keys().next().value

			if (oldestKey === undefined) {
				break
			}

			const oldestUrl = this.urls.get(oldestKey)

			if (oldestUrl !== undefined) {
				this.fns.revokeObjectUrl(oldestUrl)
			}

			this.urls.delete(oldestKey)
		}

		return url
	}

	public get(uuid: string): string | null {
		return this.urls.get(uuid) ?? null
	}

	// A plain snapshot for mirroring into the reactive store — a fresh object every call, so a component
	// subscribed via useShallow only re-renders when the actual key/url set changes.
	public snapshot(): Record<string, string> {
		return Object.fromEntries(this.urls)
	}

	public revokeAll(): void {
		for (const url of this.urls.values()) {
			this.fns.revokeObjectUrl(url)
		}

		this.urls.clear()
	}
}
