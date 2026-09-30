import { useState } from "react"
import * as FileSystem from "expo-file-system"
import useOnAppForeground from "@/hooks/useOnAppForeground"

function readAvailableDiskSpace(): number {
	const available = FileSystem.Paths.availableDiskSpace

	return Number.isFinite(available) ? Math.max(0, available) : 0
}

// Available bytes on the device volume, re-read on every foreground.
export default function useDeviceDiskSpace(): number {
	const [availableBytes, setAvailableBytes] = useState<number>(readAvailableDiskSpace)

	useOnAppForeground(() => setAvailableBytes(readAvailableDiskSpace()))

	return availableBytes
}
