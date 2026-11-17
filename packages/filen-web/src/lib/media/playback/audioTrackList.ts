// The element's own audio track list (HTMLMediaElement.audioTracks, WebKit only): a direct stream switches its audio
// track in place there, with no remux. HTMLVideoElement's typings lack it.

export interface AudioTrackLike {
	enabled: boolean
	readonly label?: string
	readonly language?: string
}

export interface AudioTrackListLike {
	readonly length: number
	[index: number]: AudioTrackLike | undefined
}

// currentTime only makes this assignable from an HTMLVideoElement.
interface ElementWithAudioTracks {
	currentTime: number
	audioTracks?: AudioTrackListLike
}

// The element's audio tracks; undefined where the browser has no such list.
export function audioTracksOf(video: HTMLMediaElement | null): AudioTrackListLike | undefined {
	const element: ElementWithAudioTracks | null = video

	return element?.audioTracks
}

// Plays the element's audio track `index` alone; false where the element has no such track.
export function enableAudioTrack(video: HTMLMediaElement | null, index: number): boolean {
	const tracks = audioTracksOf(video)

	if (tracks === undefined || index < 0 || index >= tracks.length) {
		return false
	}

	for (let at = 0; at < tracks.length; at++) {
		const track = tracks[at]

		if (track !== undefined) {
			track.enabled = at === index
		}
	}

	return true
}
