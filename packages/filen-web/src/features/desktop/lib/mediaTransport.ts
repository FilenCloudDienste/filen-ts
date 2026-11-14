import type { DesktopMediaTransport } from "@filen/shared/desktop"
import type { AudioPlaybackStatus } from "@/features/audio/store/audioQueue"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import { useSmoothTransitionsStore } from "@/features/audio/store/useSmoothTransitionsStore"
import { smoothTransitionsActive } from "@/features/audio/lib/smoothTransitionsUi"
import { desktopBridge } from "@/lib/desktop"

// What the macOS Controls menu and the tray offer: nothing without a queue, Pause while audio plays or loads, Play
// otherwise.
export function mediaTransportOf(queueLength: number, status: AudioPlaybackStatus): DesktopMediaTransport {
	if (queueLength === 0) {
		return "none"
	}

	return status === "playing" || status === "loading" ? "playing" : "paused"
}

// Reports the audio player's transport to the shell on every change (only changes cross the bridge), until the
// returned stop, which reports nothing queued.
export function reportMediaTransport(): () => void {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return () => undefined
	}

	let reported: DesktopMediaTransport = "none"

	const report = (next: DesktopMediaTransport) => {
		if (next !== reported) {
			reported = next
			bridge.app.setMediaTransport(next)
		}
	}

	const { queue, status } = useAudioStore.getState()

	report(mediaTransportOf(queue.length, status))

	const unsubscribe = useAudioStore.subscribe(state => {
		report(mediaTransportOf(state.queue.length, state.status))
	})

	return () => {
		unsubscribe()
		report("none")
	}
}

// Reports whether tracks blend now, the check of the shell's Smooth Transitions item, on every change (only changes
// cross the bridge), until the returned stop, which reports off.
export function reportSmoothTransitions(): () => void {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return () => undefined
	}

	let reported = false

	const report = (next: boolean) => {
		if (next !== reported) {
			reported = next
			bridge.app.setSmoothTransitions(next)
		}
	}

	const activeOf = (state: ReturnType<typeof useSmoothTransitionsStore.getState>) =>
		smoothTransitionsActive({ enabled: state.prefs.enabled, unavailable: state.unavailable })

	report(activeOf(useSmoothTransitionsStore.getState()))

	const unsubscribe = useSmoothTransitionsStore.subscribe(state => {
		report(activeOf(state))
	})

	return () => {
		unsubscribe()
		report(false)
	}
}
