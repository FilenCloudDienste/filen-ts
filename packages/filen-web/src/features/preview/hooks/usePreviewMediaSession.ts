import { useStageMediaSession } from "@/components/media/video/useStageMediaSession"

// A previewed video or audio file takes the Media Session from its first play on: the music pauses and the media
// keys and lock screen move to the preview until it closes. Drive audio handed to the engine never gets here.
export function usePreviewMediaSession(media: HTMLMediaElement | null, title: string): void {
	useStageMediaSession({
		video: media,
		info: { title, artist: "", artworkUrl: null },
		onNext: null,
		onPrevious: null,
		claim: "play"
	})
}
