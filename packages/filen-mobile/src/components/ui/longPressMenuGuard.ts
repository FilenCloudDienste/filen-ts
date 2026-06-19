import { createContext, useContext, useRef } from "react"

// A press held at least this long (ms) is treated as a long-press that engaged (or was meant to
// engage) the native context menu — its tap handler is dropped so a long-press can never also fire
// a row's navigate/open onPress. ~500ms ≈ the platform long-press threshold (iOS + Android), so a
// real (short) tap is never suppressed.
export const LONG_PRESS_GUARD_MS = 500

// Set to true by <Menu type="context"> (src/components/ui/menu.tsx) around its children. The shared
// pressables read it and apply the long-press guard ONLY while inside a long-press context menu —
// elsewhere they pass their handlers through untouched.
export const InsideContextMenuContext = createContext(false)

type PressHandler<T> = (options: T) => void

function nowMs(): number {
	return performance.now()
}

// Pure: should a press whose down-event was at `pressStartMs` and whose up-event is at `releaseMs`
// fire its onPress? No if it was held at least `thresholdMs` — that long a hold engaged (or was meant
// to engage) the native long-press context menu, so the row's navigate/open onPress must be dropped.
export function shouldFireGuardedPress(pressStartMs: number, releaseMs: number, thresholdMs: number = LONG_PRESS_GUARD_MS): boolean {
	return releaseMs - pressStartMs < thresholdMs
}

// Hook for the shared pressables: while inside a long-press context <Menu> it records the press-down
// time and drops onPress for a held (long) press; outside one it is a transparent passthrough. The
// ref is only ever touched inside the returned handlers (never during render).
export function useLongPressGuard<T>(
	onPress: PressHandler<T> | undefined,
	onPressIn: PressHandler<T> | undefined
): { onPress: PressHandler<T> | undefined; onPressIn: PressHandler<T> | undefined } {
	const enabled = useContext(InsideContextMenuContext)
	const pressStartMsRef = useRef<number | null>(null)

	if (!enabled || !onPress) {
		return {
			onPress,
			onPressIn
		}
	}

	return {
		onPressIn: options => {
			pressStartMsRef.current = nowMs()

			onPressIn?.(options)
		},
		onPress: options => {
			const pressStartMs = pressStartMsRef.current

			pressStartMsRef.current = null

			// Only a real held press (one that recorded a press-in) is guarded. A press with no
			// preceding onPressIn — e.g. an assistive/programmatic activation — always fires, so the
			// guard can never swallow an accessibility tap.
			if (pressStartMs !== null && !shouldFireGuardedPress(pressStartMs, nowMs())) {
				return
			}

			onPress(options)
		}
	}
}
