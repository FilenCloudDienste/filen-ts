import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { MEDIA_FORMAT_UNSUPPORTED } from "@/lib/media/mediaFailure"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

// The player's words for tracks the browser cannot play: the one track by name, several by count.
// `stopped` when playback stopped there rather than skipping on.
export function formatFailureMessage(name: string, count: number, stopped: boolean): string {
	if (count > 1) {
		return stopped ? i18n.t("audio:formatStoppedCount", { count }) : i18n.t("audio:formatSkippedCount", { count })
	}

	return stopped ? i18n.t("audio:formatStopped", { name }) : i18n.t("audio:formatSkipped", { name })
}

// The bar's error line. A format failure reads as its toast does: still the current track means playback
// stopped on it, anything else that it was skipped. Every other failure is labelled LABEL-FIRST.
export function playbackErrorLabel(error: ErrorDTO, failedTrack: QueueTrack | null, currentTrack: QueueTrack | null): string {
	if (error.kind === MEDIA_FORMAT_UNSUPPORTED && failedTrack !== null) {
		return formatFailureMessage(failedTrack.name, 1, failedTrack.uuid === currentTrack?.uuid)
	}

	return errorLabel(error)
}

const TOAST_ID = "audio-format-unsupported"

// The tracks the visible notice covers. A queue of unplayable files updates one notice with a count
// rather than stacking one per file, and a track failing again (a looping queue) is not counted twice.
// Emptied once the notice closes, so a later failure starts a fresh one.
const covered = new Set<string>()

function resetCovered(): void {
	covered.clear()
}

export function notifyFormatFailure(track: QueueTrack, stopped: boolean): void {
	covered.add(track.uuid)

	toast.warning(formatFailureMessage(track.name, covered.size, stopped), {
		id: TOAST_ID,
		onDismiss: resetCovered,
		onAutoClose: resetCovered
	})
}
