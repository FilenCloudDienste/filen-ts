import { type AudioStatus } from "expo-audio"
import audio from "@/features/audio/audio"
import events from "@/lib/events"
import ProgressBar, { useProgressValue } from "@/components/floatingBar/progressBar"

function statusToProgress(status: AudioStatus): number {
	if (!status.isLoaded || !Number.isFinite(status.duration) || status.duration <= 0) {
		return 0
	}

	return Math.min(Math.max(status.currentTime / status.duration, 0), 1)
}

function subscribeProgress(onNext: (next: number) => void): () => void {
	const subscription = events.subscribe("audioStatus", status => {
		onNext(statusToProgress(status))
	})

	return () => {
		subscription.remove()
	}
}

// Playback-position bar for the floating bar's audio slot.
const AudioProgressBar = () => {
	// Seed from the cached status: a paused player emits no audioStatus events, so a 0 seed
	// would leave the bar empty after remounting (e.g. navigating back to a tab) until resume.
	const initialStatus = audio.getStatus()
	const progress = useProgressValue(initialStatus ? statusToProgress(initialStatus) : 0, subscribeProgress)

	return <ProgressBar progress={progress} />
}

export default AudioProgressBar
