import { useSyncExternalStore } from "react"
import connectionTrust from "@/lib/connectionTrust"

/** Reactive view of `connectionTrust`: true while the connection to Filen failed certificate verification. */
export default function useIsConnectionUnverified(): boolean {
	return useSyncExternalStore(
		listener => connectionTrust.subscribe(listener),
		() => connectionTrust.isUnverified(),
		() => false
	)
}
