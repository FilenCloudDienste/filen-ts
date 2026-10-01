import { plainErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { BlockSource } from "@/lib/media/blockSource"

// Why a media element gave up on its source: "format" when the browser cannot decode the file (nothing
// a retry or a re-download changes), "other" for everything else (the stream broke, the fetch failed).
export type MediaFailureKind = "format" | "other"

// The error kinds a media failure carries into an ErrorDTO, labelled through the "errors" catalog.
export const MEDIA_FORMAT_UNSUPPORTED = "MediaFormatUnsupported"
export const MEDIA_PLAYBACK_FAILED = "MediaPlaybackFailed"

export type MediaErrorKind = typeof MEDIA_FORMAT_UNSUPPORTED | typeof MEDIA_PLAYBACK_FAILED

// MediaError's codes, restated so this stays callable where MediaError is not defined.
const MEDIA_ERR_DECODE = 3
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

// A decode error is the file. MEDIA_ERR_SRC_NOT_SUPPORTED is ambiguous: the HTML spec raises it both for
// a format the browser cannot play and for a source it could not fetch before its metadata arrived (a
// stream that broke at once, a registration the service worker no longer has). Reading the file's first
// bytes tells them apart for the price of one block, where guessing wrong would either re-download the
// whole file for nothing or blame the format for a dropped connection. An empty file has nothing to play.
export async function classifyMediaError(code: number, source: BlockSource): Promise<MediaFailureKind> {
	if (code === MEDIA_ERR_DECODE) {
		return "format"
	}

	if (code !== MEDIA_ERR_SRC_NOT_SUPPORTED) {
		return "other"
	}

	if (source.size === 0) {
		return "format"
	}

	try {
		await source.read(new Uint8Array(1), 0, 1)

		return "format"
	} catch {
		return "other"
	}
}

export function mediaFailureDTO(kind: MediaFailureKind): ErrorDTO {
	return kind === "format"
		? plainErrorDTO("media format unsupported", MEDIA_FORMAT_UNSUPPORTED)
		: plainErrorDTO("media playback failed", MEDIA_PLAYBACK_FAILED)
}

// The error handler of a media element playing `source`: reports the failure once it is classified,
// unless the element has moved on to another source by then (a failure of bytes nothing plays any more).
// Wired as the element's own onError, so no failure can land before anything listens.
export function reportMediaFailure(element: HTMLMediaElement, source: BlockSource, onFailure: (kind: MediaFailureKind) => void): void {
	const error = element.error

	if (error === null) {
		return
	}

	void classifyMediaError(error.code, source).then(kind => {
		if (element.error === error) {
			onFailure(kind)
		}
	})
}
