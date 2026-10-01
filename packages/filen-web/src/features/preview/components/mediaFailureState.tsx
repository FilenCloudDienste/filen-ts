import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { mediaFailureDTO, type MediaFailureKind } from "@/lib/media/mediaFailure"
import type { BlockSource } from "@/lib/media/blockSource"
import { browserCanPlay, CODECS, readContainerTracks, unplayableTracks, type CodecId } from "@/features/preview/lib/containerTracks"
import { PreviewDownloadButton, PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"

// The codecs in `source`'s container header that `media` reports it cannot decode; null while reading.
// A file whose header cannot be read, or that names nothing unplayable, resolves empty.
function useUnplayableCodecs(media: HTMLMediaElement, source: BlockSource): CodecId[] | null {
	const [codecs, setCodecs] = useState<CodecId[] | null>(null)

	useEffect(() => {
		let live = true

		void readContainerTracks(source)
			.then(
				tracks => (tracks === null ? [] : unplayableTracks(tracks, ["audio", "video"], browserCanPlay(media))),
				() => []
			)
			.then(found => {
				if (live) {
					setCodecs(found)
				}
			})

		return () => {
			live = false
		}
	}, [media, source])

	return codecs
}

function FormatFailure({ media, source }: { media: HTMLMediaElement; source: BlockSource }) {
	const { t } = useTranslation("preview")
	const codecs = useUnplayableCodecs(media, source)

	if (codecs === null) {
		return <PreviewLoading />
	}

	return (
		<PreviewErrorState
			message={
				codecs.length > 0
					? t("previewMediaFormatUnsupportedCodecs", { codecs: codecs.map(codec => CODECS[codec].label).join(", ") })
					: errorLabel(mediaFailureDTO("format"))
			}
			action={<PreviewDownloadButton />}
		/>
	)
}

// What a preview's video/audio shows once its element gave up: a format failure names the codecs it can
// and offers the host's Download, since no retry plays it; any other failure that reaches here has no
// fallback left (the buffered path) and says so.
export function MediaFailureState({ kind, media, source }: { kind: MediaFailureKind; media: HTMLMediaElement; source: BlockSource }) {
	if (kind === "format") {
		return (
			<FormatFailure
				media={media}
				source={source}
			/>
		)
	}

	return <PreviewErrorState message={errorLabel(mediaFailureDTO("other"))} />
}
