import { vi, describe, it, expect } from "vitest"

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

import { remainingMs } from "@/components/biometric"

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
