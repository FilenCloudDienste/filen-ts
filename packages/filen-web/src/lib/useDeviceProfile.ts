import { useSyncExternalStore } from "react"
import { deviceProfile, subscribeDeviceProfile, type DeviceProfile } from "@/lib/deviceProfile"

// The current device profile, re-rendering when a probe refines it. Apart from deviceProfile.ts so the workers that
// read the gates never load React.
export function useDeviceProfile(): DeviceProfile {
	return useSyncExternalStore(subscribeDeviceProfile, deviceProfile)
}
