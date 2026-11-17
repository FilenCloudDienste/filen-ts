import { isAppleMobile, isPhone } from "@/lib/appleMobile"
import { pdfMemoryConstrained, pdfViewerLimits } from "@/features/preview/lib/pdfLimits"

// What this device can do, as the preview gates need it. Read once at first use; a capability probe that resolves
// later refines it. Gates read the current value on every call, so nothing caches a stale answer.

// A capability only a probe can tell: "unknown" until it ran, treated like "no".
export type Probe = "unknown" | "yes" | "no"

export interface DeviceProfile {
	readonly heicNative: Probe
	readonly jxlNative: Probe
	// iOS or iPadOS WebKit.
	readonly appleMobile: boolean
	// A phone or tablet, whose tab is killed far sooner than a desktop's.
	readonly mobile: boolean
	// A phone, not a tablet.
	readonly phone: boolean
	// Largest PDF read in ranges; null for no limit.
	readonly pdfRangedMax: bigint | null
}

// A size limit that may depend on the device; null for none.
export type ProfileCap = bigint | null | ((profile: DeviceProfile) => bigint | null)

export function capFor(cap: ProfileCap, profile: DeviceProfile): bigint | null {
	return typeof cap === "function" ? cap(profile) : cap
}

let current: DeviceProfile | null = null
const listeners = new Set<() => void>()

export function deviceProfile(): DeviceProfile {
	current ??= {
		heicNative: "unknown",
		jxlNative: "unknown",
		appleMobile: isAppleMobile(),
		mobile: pdfMemoryConstrained(),
		phone: isPhone(),
		pdfRangedMax: BigInt(pdfViewerLimits().rangedMaxBytes)
	}

	return current
}

// A probe's result: a new profile, so a subscriber compares by identity.
export function refineDeviceProfile(patch: Partial<Pick<DeviceProfile, "heicNative" | "jxlNative">>): void {
	current = { ...deviceProfile(), ...patch }

	for (const listener of listeners) {
		listener()
	}
}

export function subscribeDeviceProfile(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}
