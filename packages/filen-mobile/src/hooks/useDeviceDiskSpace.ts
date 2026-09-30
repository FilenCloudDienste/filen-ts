import { useEffect, useState } from "react"
import { AppState } from "react-native"
import * as FileSystem from "expo-file-system"

function readAvailableDiskSpace(): number {
	const available = FileSystem.Paths.availableDiskSpace

	return Number.isFinite(available) ? Math.max(0, available) : 0
}

// Available bytes on the device volume, re-read on every foreground.
export default function useDeviceDiskSpace(): number {
	const [availableBytes, setAvailableBytes] = useState<number>(readAvailableDiskSpace)

	useEffect(() => {
		const subscription = AppState.addEventListener("change", next => {
			if (next === "active") {
				setAvailableBytes(readAvailableDiskSpace())
			}
		})

		return () => {
			subscription.remove()
		}
	}, [])

	return availableBytes
}
