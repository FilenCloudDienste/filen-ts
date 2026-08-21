import { useEffect, useState } from "react"
import { AppState } from "react-native"
import batteryOptimization from "@/lib/batteryOptimization"

/**
 * Whether Android is battery-optimizing this app (i.e. we are NOT on the power allowlist).
 *
 * Re-reads on every foreground transition, because the only way to change it is to leave for system
 * settings and come back — without that the hint would still be showing after the user has already
 * fixed it. Always false on iOS.
 *
 * Starts false so nothing renders until the first read resolves: a warning that flashes in and then
 * disappears is worse than one that appears a beat late.
 */
export default function useIsBatteryOptimized(): boolean {
	const [restricted, setRestricted] = useState<boolean>(false)

	useEffect(() => {
		// One liveness flag for BOTH the initial read and every foreground re-read — each is a separate
		// in-flight promise that could otherwise resolve after unmount.
		let alive = true

		const refresh = (): void => {
			batteryOptimization.isRestricted().then(next => {
				if (alive) {
					setRestricted(next)
				}
			})
		}

		refresh()

		const listener = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				refresh()
			}
		})

		return () => {
			alive = false

			listener.remove()
		}
	}, [])

	return restricted
}
