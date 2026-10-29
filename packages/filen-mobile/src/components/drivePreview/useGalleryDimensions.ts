import { useState } from "react"
import { useWindowDimensions, Platform } from "react-native"
import usePipStore from "@/stores/usePip.store"

type Dimensions = {
	width: number
	height: number
}

function sameSize(a: Dimensions, b: Dimensions): boolean {
	return a.width === b.width && a.height === b.height
}

// Android PiP shrinks the activity window to the floating window's size. The gallery keeps the pre-PiP
// geometry until the window is restored: cells sized to the PiP window re-virtualize the pager and
// unmount the presenting VideoView, and expo-video reports PiP-stop only to views still mounted, so the
// session would never end. PiP-stop lands before the restore resize, hence the hold past the session.
// iOS PiP never resizes the window.
export function useGalleryDimensions(): Dimensions {
	const dimensions = useWindowDimensions()
	const pipActive = usePipStore(state => Platform.OS === "android" && state.activeKey !== null)
	const [preSession, setPreSession] = useState<Dimensions>({
		width: dimensions.width,
		height: dimensions.height
	})
	// The PiP window's size, held until the window leaves it.
	const [pipWindow, setPipWindow] = useState<Dimensions | null>(null)

	if (pipActive) {
		if (!sameSize(dimensions, preSession) && (pipWindow === null || !sameSize(dimensions, pipWindow))) {
			setPipWindow({
				width: dimensions.width,
				height: dimensions.height
			})
		}

		return preSession
	}

	if (pipWindow !== null && sameSize(dimensions, pipWindow)) {
		return preSession
	}

	if (pipWindow !== null) {
		setPipWindow(null)
	}

	if (!sameSize(dimensions, preSession)) {
		setPreSession({
			width: dimensions.width,
			height: dimensions.height
		})
	}

	return dimensions
}

export default useGalleryDimensions
