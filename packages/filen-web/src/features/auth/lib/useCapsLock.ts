import { useState } from "react"

// Caps-lock state is not queryable — it is only readable from a real keyboard/mouse event's modifier
// state, so it can only be known once the user types. Tracked per input and cleared on blur, so the
// warning can only ever appear under the focused field (caps lock is global; lighting up every
// password field on the screen at once would be noise).
export function useCapsLock(): {
	capsLockOn: boolean
	// Structural, not React.KeyboardEvent, so the hook is testable with a plain object. The key
	// parameter is the literal this hook asks for, NOT `string`: React types getModifierState as
	// (key: ModifierKey), and a handler demanding a wider `string` parameter is not assignable to
	// KeyboardEventHandler under strictFunctionTypes.
	onKeyDown: (e: { getModifierState: (key: "CapsLock") => boolean }) => void
	onKeyUp: (e: { getModifierState: (key: "CapsLock") => boolean }) => void
	onBlur: () => void
} {
	const [capsLockOn, setCapsLockOn] = useState(false)

	return {
		capsLockOn,
		onKeyDown: e => {
			setCapsLockOn(e.getModifierState("CapsLock"))
		},
		// Keyup is what catches the user toggling caps lock while focused without typing.
		onKeyUp: e => {
			setCapsLockOn(e.getModifierState("CapsLock"))
		},
		onBlur: () => {
			setCapsLockOn(false)
		}
	}
}
