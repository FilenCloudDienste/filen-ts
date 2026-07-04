import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"

// The active Picture-in-Picture session (spec: docs/pip-video-player.md §5.2). `activeKey` is the
// gallery player cacheKey of the video currently presented in the system PiP window, or null when
// no PiP session exists. The KEY (not a boolean) is required: the gallery must exempt exactly this
// player from LRU eviction and pauseAllExcept, or paging/browsing kills the floating window.
//
// Consumers: the HTTP-provider lifecycle (components/http.tsx — keep the decrypting localhost
// server alive while a PiP session streams), the biometric lock machine (components/biometric.tsx —
// an active PiP session extends the foreground session), the iOS privacy cover
// (components/privacyScreen.tsx — suppressed while the preview is the last-visible screen), and
// the gallery player manager (components/drivePreview/galleryVideoPlayers.ts).
export type PipStore = {
	activeKey: string | null
	setActiveKey: (fn: string | null | ((prev: string | null) => string | null)) => void
}

export const usePipStore = create<PipStore>()(
	subscribeWithSelector(set => ({
		activeKey: null,
		setActiveKey(fn) {
			set(state => ({
				activeKey: typeof fn === "function" ? fn(state.activeKey) : fn
			}))
		}
	}))
)

export default usePipStore
