import { useEffect } from "react"

/**
 * Runs `effect` exactly once for the component's lifetime, on mount.
 *
 * The empty dependency array is intentional and the exhaustive-deps lint is
 * suppressed, so `effect` closes over the values from the FIRST render and never
 * sees later ones — a stale closure by design. Only safe for effects that read
 * refs, stable singletons (lib services, stores), or module-level values. Do NOT
 * use it for an effect that depends on current props/state, and note the returned
 * cleanup runs only on unmount, never on a dependency change.
 */
export default function useEffectOnce(effect: React.EffectCallback) {
	// eslint-disable-next-line react-compiler/react-compiler
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(effect, [])
}
