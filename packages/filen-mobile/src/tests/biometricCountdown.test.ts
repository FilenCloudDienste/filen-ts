import { vi, describe, it, expect } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// Stub all native/expo modules pulled in transitively by biometric.tsx.
// Only remainingMs (a pure function) is under test — none of these impls matter.

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))
vi.mock("expo-local-authentication", () => ({
	authenticateAsync: vi.fn()
}))
vi.mock("expo-modules-core", () => ({
	requireNativeModule: vi.fn(() => ({})),
	EventEmitter: class {
		addListener() {}
		removeAllListeners() {}
	}
}))
vi.mock("react-native-screens", () => ({ FullWindowOverlay: "FullWindowOverlay" }))
vi.mock("react-native-svg", () => ({
	default: "Svg",
	Circle: "Circle"
}))
vi.mock("react-native-reanimated", () => ({
	FadeOut: {},
	default: {}
}))
vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 }))
}))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }))
vi.mock("uniwind", () => ({ useResolveClassNames: vi.fn(() => ({})) }))
vi.mock("@/lib/secureStore", () => ({
	default: { get: vi.fn(), set: vi.fn() },
	useSecureStore: vi.fn(() => [{ enabled: false }, vi.fn()])
}))
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/prompts", () => ({ default: { input: vi.fn() } }))
vi.mock("@/stores/useApp.store", () => ({
	default: {
		getState: vi.fn(() => ({ setBiometricUnlocked: vi.fn() }))
	}
}))
vi.mock("@/queries/useLocalAuthentication.query", () => ({ fetchData: vi.fn() }))
vi.mock("@/features/settings/screens/biometric", () => ({}))
vi.mock("@/hooks/useEffectOnce", () => ({ default: vi.fn() }))
vi.mock("@/components/ui/view", () => ({ default: "View" }))
vi.mock("@/components/ui/text", () => ({ default: "Text" }))
vi.mock("@/components/ui/pressables", () => ({ PressableOpacity: "PressableOpacity" }))
vi.mock("@/components/ui/animated", () => ({ AnimatedView: "AnimatedView" }))
vi.mock("@filen/utils", () => ({
	run: vi.fn(),
	runEffect: vi.fn()
}))
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (k: string) => k }))
}))

import {
	remainingMs,
	shouldLockOnBackground,
	shouldAutoUnlockOnForeground,
	shouldReLockOnForeground,
	shouldReLockOnPresentationEnd,
	reduceBiometricAppState,
	type BiometricAppStateContext
} from "@/components/biometric"

// Baseline context: enabled + authenticated, 10s grace, nothing pending. Each test overrides the fields it
// exercises. `now` defaults to a fixed epoch so the assertions are deterministic.
function ctx(overrides: Partial<BiometricAppStateContext> = {}): BiometricAppStateContext {
	return {
		enabled: true,
		authenticated: true,
		presentationActive: false,
		suppressed: false,
		lockAfterMs: 10_000,
		wasBackground: false,
		lockedByBackground: false,
		backgroundedBehindPresentation: false,
		pipSessionActive: false,
		backgroundedDuringPipSession: false,
		pipStopGraceApplies: false,
		lastAppCloseTimestamp: 0,
		now: 1_000_000,
		...overrides
	}
}

describe("remainingMs", () => {
	it("returns positive ms when lockedUntil is in the future", () => {
		const now = 1_000_000
		const lockedUntil = now + 5000

		expect(remainingMs(now, lockedUntil)).toBe(5000)
	})

	it("returns 0 exactly when now equals lockedUntil", () => {
		const now = 1_000_000

		expect(remainingMs(now, now)).toBe(0)
	})

	it("returns 0 (not negative) when lockedUntil is in the past", () => {
		const now = 1_000_000
		const lockedUntil = now - 2000

		expect(remainingMs(now, lockedUntil)).toBe(0)
	})

	it("returns 0 when lockedUntil is zero (unlocked state)", () => {
		expect(remainingMs(Date.now(), 0)).toBe(0)
	})

	it("countdown reaches expiry exactly on the last tick", () => {
		// Simulate 3-second countdown ticking down to 0
		const base = 10_000
		const lockedUntil = base + 3000

		expect(remainingMs(base, lockedUntil)).toBe(3000)
		expect(remainingMs(base + 1000, lockedUntil)).toBe(2000)
		expect(remainingMs(base + 2000, lockedUntil)).toBe(1000)
		expect(remainingMs(base + 3000, lockedUntil)).toBe(0)
		// Any tick after expiry must not go negative
		expect(remainingMs(base + 4000, lockedUntil)).toBe(0)
	})
})

describe("shouldLockOnBackground", () => {
	it("locks when enabled, authenticated, and no presentation literally on screen", () => {
		expect(shouldLockOnBackground(true, true, false, false)).toBe(true)
	})

	it("does not lock when biometric is disabled", () => {
		expect(shouldLockOnBackground(false, true, false, false)).toBe(false)
	})

	it("does not lock when not currently authenticated (preserves an active lockout / prompt)", () => {
		expect(shouldLockOnBackground(true, false, false, false)).toBe(false)
	})

	it("does not lock while a presentation is literally on screen (raw activeCount)", () => {
		expect(shouldLockOnBackground(true, true, true, false)).toBe(false)
	})

	it("does not lock while a PiP session is active (user-initiated surface keeps the app open)", () => {
		expect(shouldLockOnBackground(true, true, false, true)).toBe(false)
	})
})

describe("shouldReLockOnForeground", () => {
	it("re-locks when gone longer than lockAfter and not suppressed", () => {
		expect(shouldReLockOnForeground(true, true, 10_001, 10_000, false)).toBe(true)
	})

	it("does not re-lock within lockAfter", () => {
		expect(shouldReLockOnForeground(true, true, 10_000, 10_000, false)).toBe(false)
		expect(shouldReLockOnForeground(true, true, 5000, 10_000, false)).toBe(false)
	})

	it("does not re-lock while suppressed (returning straight from a picker within grace)", () => {
		expect(shouldReLockOnForeground(true, true, 20_000, 10_000, true)).toBe(false)
	})

	it("does not re-lock when disabled or not authenticated", () => {
		expect(shouldReLockOnForeground(false, true, 20_000, 10_000, false)).toBe(false)
		expect(shouldReLockOnForeground(true, false, 20_000, 10_000, false)).toBe(false)
	})
})

// VC1 regression: the residual presentation-end re-lock is gated on the explicit "a real background fired
// behind a still-pending presentation" flag, NOT a bare elapsed > lockAfter against a possibly stale/zero
// lastAppCloseTimestamp. The three required cases:
//   (a) fresh session, picker roundtrip with NO real background → flag false → MUST NOT lock.
//   (b) a real background behind a still-pending picker, beyond lockAfter → flag true → MUST lock.
//   (c) returning straight from a picker within grace (no real background) → flag false → MUST NOT lock.
describe("shouldReLockOnPresentationEnd", () => {
	it("(a) does NOT lock on a fresh-session picker roundtrip with no real background", () => {
		// Fresh session: lastAppCloseTimestamp 0 → elapsed is astronomically large, but no real background
		// occurred so the flag is false. The OLD bare elapsed > lockAfter check would have spuriously locked.
		expect(shouldReLockOnPresentationEnd(true, true, false, 1_000_000, 10_000)).toBe(false)
	})

	it("(b) locks on a real background behind a still-pending picker beyond lockAfter", () => {
		expect(shouldReLockOnPresentationEnd(true, true, true, 10_001, 10_000)).toBe(true)
	})

	it("(c) does NOT lock when returning straight from a picker within grace (no real background)", () => {
		// An ordinary picker resigns the app to "inactive", never "background", so no close timestamp is stamped
		// and the flag stays false — even if the (stale) elapsed happens to exceed lockAfter.
		expect(shouldReLockOnPresentationEnd(true, true, false, 20_000, 10_000)).toBe(false)
		// And a genuinely quick roundtrip (elapsed within lockAfter) never locks regardless of the flag.
		expect(shouldReLockOnPresentationEnd(true, true, true, 5000, 10_000)).toBe(false)
	})

	it("does not lock at exactly lockAfter (boundary), only strictly beyond it", () => {
		expect(shouldReLockOnPresentationEnd(true, true, true, 10_000, 10_000)).toBe(false)
	})

	it("does not lock when disabled or not authenticated even with the flag armed and beyond lockAfter", () => {
		expect(shouldReLockOnPresentationEnd(false, true, true, 20_000, 10_000)).toBe(false)
		expect(shouldReLockOnPresentationEnd(true, false, true, 20_000, 10_000)).toBe(false)
	})
})

describe("shouldAutoUnlockOnForeground", () => {
	it("auto-unlocks a background lock when returning within the grace window", () => {
		expect(shouldAutoUnlockOnForeground(true, 5000, 10_000, false)).toBe(true)
		expect(shouldAutoUnlockOnForeground(true, 10_000, 10_000, false)).toBe(true)
	})

	it("does not auto-unlock beyond the grace window (BiometricInner prompts instead)", () => {
		expect(shouldAutoUnlockOnForeground(true, 10_001, 10_000, false)).toBe(false)
	})

	it("does not auto-unlock when we did not lock on background", () => {
		expect(shouldAutoUnlockOnForeground(false, 0, 10_000, false)).toBe(false)
	})

	it("does not auto-unlock while suppressed", () => {
		expect(shouldAutoUnlockOnForeground(true, 0, 10_000, true)).toBe(false)
	})

	it("with a zero grace (lock immediately), any elapsed > 0 requires a prompt", () => {
		expect(shouldAutoUnlockOnForeground(true, 1, 0, false)).toBe(false)
		expect(shouldAutoUnlockOnForeground(true, 0, 0, false)).toBe(true)
	})
})

describe("reduceBiometricAppState", () => {
	it("locks on background when enabled, authenticated and not suppressed", () => {
		const result = reduceBiometricAppState("background", ctx({ now: 5000 }))

		expect(result.setAuthenticated).toBe(false)
		expect(result.lockedByBackground).toBe(true)
		expect(result.wasBackground).toBe(true)
		expect(result.lastAppCloseTimestamp).toBe(5000)
		expect(result.rekeyPrompt).toBe(false)
	})

	it("records the background transition but does not lock when not authenticated", () => {
		const result = reduceBiometricAppState("background", ctx({ authenticated: false, now: 5000 }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.lockedByBackground).toBe(false)
		// Still sticky-flags the background + stamps the close time so a later return is handled correctly.
		expect(result.wasBackground).toBe(true)
		expect(result.lastAppCloseTimestamp).toBe(5000)
	})

	it("does not lock on background when biometric is disabled", () => {
		const result = reduceBiometricAppState("background", ctx({ enabled: false }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.lockedByBackground).toBe(false)
		expect(result.wasBackground).toBe(true)
	})

	it("does not lock on background while a presentation is literally on screen (presentationActive)", () => {
		const result = reduceBiometricAppState("background", ctx({ presentationActive: true }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.lockedByBackground).toBe(false)
		expect(result.wasBackground).toBe(true)
	})

	// VC1: a REAL background fired while a picker was literally on screen → lock-on-background suppressed, but
	// arm backgroundedBehindPresentation (with lastAppCloseTimestamp stamped) so the residual presentation-end
	// subscription can later fail closed. This is the ONLY place the flag is armed.
	it("arms backgroundedBehindPresentation on a real background behind a literally-on-screen presentation", () => {
		const result = reduceBiometricAppState("background", ctx({ presentationActive: true, now: 5000 }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.lockedByBackground).toBe(false)
		expect(result.backgroundedBehindPresentation).toBe(true)
		expect(result.lastAppCloseTimestamp).toBe(5000)
	})

	it("does NOT arm backgroundedBehindPresentation on an ordinary background (no presentation on screen)", () => {
		const result = reduceBiometricAppState("background", ctx({ presentationActive: false }))

		// Ordinary background locks normally; the residual flag stays false so the presentation-end path is inert.
		expect(result.setAuthenticated).toBe(false)
		expect(result.lockedByBackground).toBe(true)
		expect(result.backgroundedBehindPresentation).toBe(false)
	})

	it("keeps backgroundedBehindPresentation armed across a foreground that is still suppressed (picker pending)", () => {
		// Arm it on the suppressed background.
		const bg = reduceBiometricAppState("background", ctx({ presentationActive: true, now: 1000 }))

		expect(bg.backgroundedBehindPresentation).toBe(true)

		// Return active while the picker is STILL pending (suppressed true) and beyond lockAfter: the reducer's
		// re-lock can't act yet, so the flag must persist for the residual presentation-end subscription.
		const active = reduceBiometricAppState(
			"active",
			ctx({
				authenticated: true,
				wasBackground: bg.wasBackground,
				lockedByBackground: bg.lockedByBackground,
				backgroundedBehindPresentation: bg.backgroundedBehindPresentation,
				lastAppCloseTimestamp: bg.lastAppCloseTimestamp,
				suppressed: true,
				lockAfterMs: 10_000,
				now: 20_000 // elapsed 19000 > 10000, but suppressed → reducer defers
			})
		)

		expect(active.setAuthenticated).toBe(null)
		expect(active.backgroundedBehindPresentation).toBe(true)
		expect(active.rekeyPrompt).toBe(true)
	})

	it("clears backgroundedBehindPresentation once the foreground re-lock resolves it (not suppressed)", () => {
		const bg = reduceBiometricAppState("background", ctx({ presentationActive: true, now: 1000 }))

		expect(bg.backgroundedBehindPresentation).toBe(true)

		// Return active with the presentation released (suppressed false) beyond lockAfter: the reducer re-locks
		// here, so the flag is consumed and the residual subscription has nothing left to do.
		const active = reduceBiometricAppState(
			"active",
			ctx({
				authenticated: true,
				wasBackground: bg.wasBackground,
				lockedByBackground: bg.lockedByBackground,
				backgroundedBehindPresentation: bg.backgroundedBehindPresentation,
				lastAppCloseTimestamp: bg.lastAppCloseTimestamp,
				suppressed: false,
				lockAfterMs: 10_000,
				now: 20_000 // elapsed 19000 > 10000, not suppressed → reducer re-locks now
			})
		)

		expect(active.setAuthenticated).toBe(false)
		expect(active.backgroundedBehindPresentation).toBe(false)
	})

	// Finding #11 (scenario b): a REAL background within the post-release grace window (presentation already
	// off screen → presentationActive false, but suppressed still true) must FAIL CLOSED and lock. The old
	// single-`suppressed` decision wrongly skipped this — a security gate that failed open.
	it("locks on a real background within the grace window (presentationActive false but suppressed true)", () => {
		const result = reduceBiometricAppState("background", ctx({ presentationActive: false, suppressed: true, now: 5000 }))

		expect(result.setAuthenticated).toBe(false)
		expect(result.lockedByBackground).toBe(true)
		expect(result.wasBackground).toBe(true)
		expect(result.lastAppCloseTimestamp).toBe(5000)
	})

	it("auto-unlocks on foreground when returning within the grace window", () => {
		const result = reduceBiometricAppState(
			"active",
			ctx({
				wasBackground: true,
				lockedByBackground: true,
				lastAppCloseTimestamp: 1000,
				lockAfterMs: 10_000,
				now: 6000 // elapsed 5000 <= 10000
			})
		)

		expect(result.setAuthenticated).toBe(true)
		expect(result.wasBackground).toBe(false)
		expect(result.lockedByBackground).toBe(false)
		expect(result.rekeyPrompt).toBe(true)
	})

	it("stays locked (no auto-unlock) when returning beyond the grace window", () => {
		const result = reduceBiometricAppState(
			"active",
			ctx({
				// The background lock already fired (set authenticated false), so the realistic foreground ctx is
				// authenticated:false — the re-lock guard short-circuits and we just clear bookkeeping + re-key.
				authenticated: false,
				wasBackground: true,
				lockedByBackground: true,
				lastAppCloseTimestamp: 1000,
				lockAfterMs: 10_000,
				now: 20_000 // elapsed 19000 > 10000
			})
		)

		// Leave `authenticated` false (set on background) so BiometricInner prompts; still clears bookkeeping + re-keys.
		expect(result.setAuthenticated).toBe(null)
		expect(result.wasBackground).toBe(false)
		expect(result.lockedByBackground).toBe(false)
		expect(result.rekeyPrompt).toBe(true)
	})

	// Finding #11 (scenario a): the background transition was suppressed because a picker promise stayed pending
	// the whole absence (presentationActive true at background → no lock applied, still authenticated). The user
	// was gone longer than lockAfter, so the foreground re-evaluation must FAIL CLOSED and re-lock — even though
	// we never locked on background. Grace has elapsed by return, so `suppressed` is false here.
	it("re-locks on foreground after a suppressed background that outlasted lockAfter", () => {
		const result = reduceBiometricAppState(
			"active",
			ctx({
				authenticated: true,
				wasBackground: true,
				lockedByBackground: false, // background lock was suppressed, so we never locked
				suppressed: false, // grace elapsed by the time we return
				lastAppCloseTimestamp: 1000,
				lockAfterMs: 10_000,
				now: 20_000 // elapsed 19000 > 10000
			})
		)

		expect(result.setAuthenticated).toBe(false)
		expect(result.wasBackground).toBe(false)
		expect(result.lockedByBackground).toBe(false)
		expect(result.rekeyPrompt).toBe(true)
	})

	// Finding #11: returning STRAIGHT from a picker within the post-release grace window must NOT spuriously lock,
	// even past lockAfter — the grace-inclusive `suppressed` keeps the foreground re-lock from firing.
	it("does not re-lock when returning straight from a picker within the grace window", () => {
		const result = reduceBiometricAppState(
			"active",
			ctx({
				authenticated: true,
				wasBackground: true,
				lockedByBackground: false,
				suppressed: true, // still within the post-release grace window
				lastAppCloseTimestamp: 1000,
				lockAfterMs: 10_000,
				now: 20_000 // elapsed 19000 > 10000, but grace suppresses the re-lock
			})
		)

		expect(result.setAuthenticated).toBe(null)
		expect(result.wasBackground).toBe(false)
		expect(result.rekeyPrompt).toBe(true)
	})

	it("handles the iOS background -> inactive -> active ordering via the sticky wasBackground flag", () => {
		// 1) background: lock + stamp close time.
		const bg = reduceBiometricAppState("background", ctx({ now: 1000 }))

		expect(bg.wasBackground).toBe(true)
		expect(bg.lockedByBackground).toBe(true)
		expect(bg.setAuthenticated).toBe(false)

		// 2) inactive: a no-op that must NOT clear the sticky flag (iOS inserts this between background and active).
		const inactive = reduceBiometricAppState(
			"inactive",
			ctx({
				wasBackground: bg.wasBackground,
				lockedByBackground: bg.lockedByBackground,
				lastAppCloseTimestamp: bg.lastAppCloseTimestamp,
				authenticated: false,
				now: 1500
			})
		)

		expect(inactive.setAuthenticated).toBe(null)
		expect(inactive.wasBackground).toBe(true)
		expect(inactive.lockedByBackground).toBe(true)
		expect(inactive.rekeyPrompt).toBe(false)

		// 3) active within grace: the sticky flag still fires the auto-unlock block.
		const active = reduceBiometricAppState(
			"active",
			ctx({
				wasBackground: inactive.wasBackground,
				lockedByBackground: inactive.lockedByBackground,
				lastAppCloseTimestamp: inactive.lastAppCloseTimestamp,
				authenticated: false,
				lockAfterMs: 10_000,
				now: 3000 // elapsed 2000 <= 10000
			})
		)

		expect(active.setAuthenticated).toBe(true)
		expect(active.wasBackground).toBe(false)
		expect(active.rekeyPrompt).toBe(true)
	})

	it("with a zero grace (lock immediately), returning never auto-unlocks", () => {
		const result = reduceBiometricAppState(
			"active",
			ctx({
				// lockAfter 0 means the background lock already fired → realistic foreground ctx is authenticated:false.
				authenticated: false,
				wasBackground: true,
				lockedByBackground: true,
				lastAppCloseTimestamp: 1000,
				lockAfterMs: 0,
				now: 1001 // elapsed 1 > 0
			})
		)

		expect(result.setAuthenticated).toBe(null)
		expect(result.rekeyPrompt).toBe(true)
	})

	it("inactive without a prior background is a pure no-op", () => {
		const result = reduceBiometricAppState("inactive", ctx())

		expect(result.setAuthenticated).toBe(null)
		expect(result.wasBackground).toBe(false)
		expect(result.lockedByBackground).toBe(false)
		expect(result.rekeyPrompt).toBe(false)
	})

	it("active without a prior background is a pure no-op (does not re-key or unlock)", () => {
		const result = reduceBiometricAppState("active", ctx({ wasBackground: false }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.wasBackground).toBe(false)
		expect(result.rekeyPrompt).toBe(false)
	})
})

// ─── PiP session suppression (spec: docs/pip-video-player.md §5.6.1) ───────────
//
// An active Picture-in-Picture session extends the foreground session. The reducer suppresses the
// lock-on-background and the foreground re-lock while the session lives; the PiP-stop store
// subscription (component-level) fails closed the moment the session ends while backgrounded, with
// PIP_STOP_GRACE_MS absorbing the stop-before-active event order on expand-back. Every case runs at
// lockAfter 0 where relevant — the enable-time DEFAULT — because that configuration has zero
// accidental slack for ordering races.

describe("reduceBiometricAppState — PiP session suppression", () => {
	it("does not lock on background while a PiP session is active, arms the sticky flag, stamps the close time", () => {
		const result = reduceBiometricAppState("background", ctx({ pipSessionActive: true, now: 5000 }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.lockedByBackground).toBe(false)
		expect(result.backgroundedDuringPipSession).toBe(true)
		expect(result.wasBackground).toBe(true)
		expect(result.lastAppCloseTimestamp).toBe(5000)
	})

	it("does not arm the pip flag when not authenticated (an existing lock/prompt is preserved)", () => {
		const result = reduceBiometricAppState("background", ctx({ pipSessionActive: true, authenticated: false }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.backgroundedDuringPipSession).toBe(false)
	})

	it("does not arm the pip flag when biometric is disabled (nothing to suppress)", () => {
		const result = reduceBiometricAppState("background", ctx({ pipSessionActive: true, enabled: false }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.lockedByBackground).toBe(false)
		expect(result.backgroundedDuringPipSession).toBe(false)
	})

	it("presentation suppression takes precedence over the pip flag when both are on screen", () => {
		const result = reduceBiometricAppState("background", ctx({ presentationActive: true, pipSessionActive: true }))

		expect(result.setAuthenticated).toBe(null)
		expect(result.backgroundedBehindPresentation).toBe(true)
		expect(result.backgroundedDuringPipSession).toBe(false)
	})

	it("expand-back with the session still alive (active-before-stop order) never re-locks — even at lockAfter 0 after a long session", () => {
		const bg = reduceBiometricAppState("background", ctx({ pipSessionActive: true, now: 1000, lockAfterMs: 0 }))

		expect(bg.backgroundedDuringPipSession).toBe(true)

		const active = reduceBiometricAppState(
			"active",
			ctx({
				pipSessionActive: true,
				wasBackground: bg.wasBackground,
				lockedByBackground: bg.lockedByBackground,
				backgroundedDuringPipSession: bg.backgroundedDuringPipSession,
				lastAppCloseTimestamp: bg.lastAppCloseTimestamp,
				lockAfterMs: 0,
				now: 3_601_000 // an hour in PiP — elapsed vastly exceeds lockAfter
			})
		)

		expect(active.setAuthenticated).toBe(null)
		expect(active.backgroundedDuringPipSession).toBe(false)
		expect(active.rekeyPrompt).toBe(true)
	})

	it("expand-back in the stop-before-active order auto-unlocks within PIP_STOP_GRACE_MS at lockAfter 0", () => {
		// The PiP-stop subscription already ran: locked (fail closed), lockedByBackground true,
		// lastAppCloseTimestamp re-stamped to the stop time, sticky flag cleared. "active" arrives
		// moments later with the stop-grace applying.
		const result = reduceBiometricAppState(
			"active",
			ctx({
				authenticated: false,
				wasBackground: true,
				lockedByBackground: true,
				backgroundedDuringPipSession: false,
				pipStopGraceApplies: true,
				lastAppCloseTimestamp: 10_000,
				lockAfterMs: 0,
				now: 10_100 // elapsed 100ms — within the widened window
			})
		)

		expect(result.setAuthenticated).toBe(true)
		expect(result.lockedByBackground).toBe(false)
	})

	it("a PiP-stop long before the return stays locked and prompts (grace no longer applies)", () => {
		const result = reduceBiometricAppState(
			"active",
			ctx({
				authenticated: false,
				wasBackground: true,
				lockedByBackground: true,
				pipStopGraceApplies: false, // stop was minutes ago
				lastAppCloseTimestamp: 10_000,
				lockAfterMs: 0,
				now: 610_000 // 10 minutes after the session ended
			})
		)

		expect(result.setAuthenticated).toBe(null)
		expect(result.rekeyPrompt).toBe(true)
	})

	it("the stop-grace also carries a lockAfter > 0 config (uses the larger of the two windows)", () => {
		const result = reduceBiometricAppState(
			"active",
			ctx({
				authenticated: false,
				wasBackground: true,
				lockedByBackground: true,
				pipStopGraceApplies: true,
				lastAppCloseTimestamp: 10_000,
				lockAfterMs: 10_000,
				now: 15_000 // elapsed 5s — within lockAfter, grace irrelevant but harmless
			})
		)

		expect(result.setAuthenticated).toBe(true)
	})

	it("an ordinary background with NO pip session locks exactly as before (regression parity)", () => {
		const result = reduceBiometricAppState("background", ctx({ pipSessionActive: false, now: 5000 }))

		expect(result.setAuthenticated).toBe(false)
		expect(result.lockedByBackground).toBe(true)
		expect(result.backgroundedDuringPipSession).toBe(false)
	})
})
