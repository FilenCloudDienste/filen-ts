import { useRef, useState } from "react"

export interface InFlightKeys {
	inFlight: ReadonlySet<string>
	// Claims the keys not already in flight and returns them; an empty result leaves nothing to run.
	claim: (keys: readonly string[]) => string[]
	release: (keys: readonly string[]) => void
}

const NONE: ReadonlySet<string> = new Set()

// Keys whose op is still running, for an action with no confirm dialog to hold a second click. Claims
// go through a ref, so a click landing before the re-render that disables its control still sees the
// first one; the state copy only drives rendering.
export function useInFlightKeys(): InFlightKeys {
	const claimedRef = useRef<Set<string> | null>(null)
	const [inFlight, setInFlight] = useState(NONE)

	function claimed(): Set<string> {
		claimedRef.current ??= new Set()

		return claimedRef.current
	}

	function claim(keys: readonly string[]): string[] {
		const set = claimed()
		const fresh = keys.filter(key => !set.has(key))

		if (fresh.length === 0) {
			return fresh
		}

		for (const key of fresh) {
			set.add(key)
		}

		setInFlight(new Set(set))

		return fresh
	}

	function release(keys: readonly string[]): void {
		const set = claimed()

		for (const key of keys) {
			set.delete(key)
		}

		setInFlight(set.size === 0 ? NONE : new Set(set))
	}

	return { inFlight, claim, release }
}
