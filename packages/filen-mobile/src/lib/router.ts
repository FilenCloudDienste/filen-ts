import { router as expoRouter } from "expo-router"
import { type NavigationRecord, NAV_DEDUPE_WINDOW_MS, navigationKey, shouldDedupeNavigation } from "@/lib/navigationGuard"

// Navigation methods whose rapid identical repeat is a double-fire (a double/triple-tapped row or a
// double-tapped back button) and must be dropped. Query/param methods (canGoBack, setParams, reload,
// …) pass through untouched.
const GUARDED_METHODS = new Set<string>(["push", "replace", "navigate", "back", "dismiss", "dismissAll", "dismissTo"])

let lastNavigation: NavigationRecord | null = null

const guardedMethodCache = new Map<string, (...args: unknown[]) => unknown>()

function nowMs(): number {
	return performance.now()
}

function makeGuardedMethod(method: string, original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
	return (...args: unknown[]): unknown => {
		const key = navigationKey(args)
		const now = nowMs()

		const deduped = shouldDedupeNavigation(lastNavigation, { method, key }, now, NAV_DEDUPE_WINDOW_MS)

		// Record every guarded call (even the ones we drop) so the dedupe window slides to each tap, not
		// just to the last one we accepted. Otherwise a sustained burst of identical taps re-fires every
		// NAV_DEDUPE_WINDOW_MS — a triple-tap at ~300ms cadence would drop the 2nd tap but ACCEPT the 3rd
		// (its 600ms gap from the first accepted nav exceeds the window), pushing a duplicate screen. The
		// window must clear only after NAV_DEDUPE_WINDOW_MS of silence since the last tap.
		lastNavigation = {
			method,
			key,
			atMs: now
		}

		// Drop the rapid duplicate — a double/triple tap or double-back. The first call already navigated.
		if (deduped) {
			return undefined
		}

		return original(...args)
	}
}

// Guarded drop-in for expo-router's `router`. Identical to the real router except an identical
// navigation repeated within NAV_DEDUPE_WINDOW_MS is dropped — so a double-tapped row pushes once and a
// double-tapped back pops once, while distinct rapid navigation (push A then push B) is unaffected.
// Import this everywhere instead of expo-router's router (enforced by ESLint no-restricted-imports).
// The pure dedupe decision lives in navigationGuard.ts.
export const router: typeof expoRouter = new Proxy(expoRouter, {
	get(target, prop, receiver) {
		const value = Reflect.get(target, prop, receiver)

		if (typeof prop !== "string" || !GUARDED_METHODS.has(prop) || typeof value !== "function") {
			return value
		}

		let guarded = guardedMethodCache.get(prop)

		if (!guarded) {
			guarded = makeGuardedMethod(prop, (value as (...args: unknown[]) => unknown).bind(target))

			guardedMethodCache.set(prop, guarded)
		}

		return guarded
	}
})
