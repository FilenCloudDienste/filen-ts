import { useTranslation } from "react-i18next"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { mediaFailureDTO } from "@/lib/media/mediaFailure"
import { CODECS, type CodecId } from "@/features/preview/lib/containerTracks"
import { PreviewErrorState, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"

// A format failure: names the codecs it can and offers the host's Download, since no retry plays it.
export function MediaFormatFailure({ codecs }: { codecs: readonly CodecId[] }) {
	const { t } = useTranslation("preview")

	return (
		<PreviewUnsupportedState
			message={
				codecs.length > 0
					? t("previewMediaFormatUnsupportedCodecs", { codecs: codecs.map(codec => CODECS[codec].label).join(", ") })
					: errorLabel(mediaFailureDTO("format"))
			}
		/>
	)
}

// Nothing in this browser can stream the file (no service worker route and no MediaSource): says so, and
// offers the host's Download, whatever the file holds.
export function MediaCannotStream() {
	const { t } = useTranslation("preview")

	return <PreviewUnsupportedState message={t("previewMediaCannotStream")} />
}

// A stream that could not be read, with nothing further to fall back to; Retry plays it again.
export function MediaPlaybackFailure({ onRetry }: { onRetry?: (() => void) | undefined }) {
	return (
		<PreviewErrorState
			message={errorLabel(mediaFailureDTO("other"))}
			{...(onRetry === undefined ? {} : { onRetry })}
		/>
	)
}
