import { useState, type Dispatch, type SetStateAction } from "react"

// Form state for a dialog that stays mounted across open/close: re-seeded from `seed` on every
// closed-to-open transition, so a dismissed prompt never resurfaces a stale value. Adjusts state
// during render (React's "reset state when a prop changes" pattern) rather than in an effect, which
// would commit an extra render pass. `seed` is read only at that transition.
export function useSeededOnOpen(open: boolean, seed: string): [string, Dispatch<SetStateAction<string>>] {
	const [wasOpen, setWasOpen] = useState(open)
	const [value, setValue] = useState(seed)

	if (open !== wasOpen) {
		setWasOpen(open)

		if (open) {
			setValue(seed)
		}
	}

	return [value, setValue]
}
