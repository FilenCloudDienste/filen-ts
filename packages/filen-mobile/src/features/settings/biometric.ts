import { useSecureStore } from "@/lib/secureStore"

// secureStore key for the biometric/PIN app lock. Read by <Biometric /> (src/components/biometric.tsx),
// written by the Biometric settings screen, and gated against by the file/documents provider.
export const BIOMETRIC_SECURE_STORE_KEY = "biometric"

export type Biometric =
	| {
			enabled: false
	  }
	| {
			enabled: true
			fallback: string
			lockAfter: number
			lockedUntil: number
			lockedMultiplier: number
			pinOnly: boolean
	  }

export const DEFAULT_BIOMETRIC: Biometric = {
	enabled: false
}

export function useBiometric(): [Biometric, (next: Biometric | ((prev: Biometric) => Biometric)) => void] {
	return useSecureStore<Biometric>(BIOMETRIC_SECURE_STORE_KEY, DEFAULT_BIOMETRIC)
}
