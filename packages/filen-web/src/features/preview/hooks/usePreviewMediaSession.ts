import { use } from "react"
import { useStageMediaSession } from "@/components/media/video/useStageMediaSession"
import { PreviewMediaPagerContext } from "@/features/preview/lib/mediaPager"

// A previewed video or audio file takes the Media Session from its first play on: the music pauses and the media
// keys and lock screen move to the preview until it closes. Next/previous track page the overlay. Drive audio handed
// to the engine never gets here.
export function usePreviewMediaSession(media: HTMLMediaElement | null, title: string): void {
	const pager = use(PreviewMediaPagerContext)

	useStageMediaSession({
		video: media,
		info: { title, artist: "", artworkUrl: null },
		onNext: pager.next,
		onPrevious: pager.previous,
		claim: "play"
	})
}
