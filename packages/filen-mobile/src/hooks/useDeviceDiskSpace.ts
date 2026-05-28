import { useEffect, useState } from "react"
import { AppState } from "react-native"
import * as FileSystem from "expo-file-system"

export type DeviceDiskSpace = {
	availableBytes: number
	totalBytes: number
}

function readDiskSpace(): DeviceDiskSpace {
	const available = FileSystem.Paths.availableDiskSpace
	const total = FileSystem.Paths.totalDiskSpace

	return {
		availableBytes: Number.isFinite(available) ? Math.max(0, available) : 0,
		totalBytes: Number.isFinite(total) ? Math.max(0, total) : 0
	}
}

export default function useDeviceDiskSpace(): DeviceDiskSpace {
	const [diskSpace, setDiskSpace] = useState<DeviceDiskSpace>(() => readDiskSpace())

	useEffect(() => {
		const subscription = AppState.addEventListener("change", next => {
			if (next === "active") {
				setDiskSpace(readDiskSpace())
			}
		})

		return () => {
			subscription.remove()
		}
	}, [])

	return diskSpace
}
