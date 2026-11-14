import { beforeEach, describe, expect, it, vi } from "vitest"

const { fakeStore } = vi.hoisted(() => ({ fakeStore: new Map<string, string>() }))

vi.mock("@/lib/storage/leader", () => ({
	acquireStorage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				open: () => Promise.resolve(undefined),
				kvGet: (key: string) => Promise.resolve(fakeStore.get(key) ?? null),
				kvSet: (key: string, value: string) => {
					fakeStore.set(key, value)

					return Promise.resolve()
				},
				kvDelete: (key: string) => {
					fakeStore.delete(key)

					return Promise.resolve()
				},
				kvKeys: (prefix: string) => Promise.resolve([...fakeStore.keys()].filter(k => k.startsWith(prefix)))
			}
		})
}))

import {
	clampFadeSeconds,
	normalizeSmoothTransitionsPrefs,
	setSmoothTransitionsPrefs,
	setSmoothTransitionsUnavailable,
	toggleSmoothTransitions,
	useSmoothTransitionsStore
} from "@/features/audio/store/useSmoothTransitionsStore"
import { DEFAULT_SMOOTH_TRANSITIONS_PREFS, SMOOTH_TRANSITIONS_PREFS_KEY } from "@/features/audio/lib/smoothTransitions.types"
import { smoothTransitionsAvailabilityFor } from "@/features/audio/lib/smoothTransitionsAvailability"

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve()
	}
}

describe("smooth transition prefs", () => {
	beforeEach(() => {
		fakeStore.clear()
		useSmoothTransitionsStore.setState({ prefs: DEFAULT_SMOOTH_TRANSITIONS_PREFS, unavailable: null })
	})

	it("clamps the fade length to whole seconds between 1 and 12", () => {
		expect(clampFadeSeconds(0)).toBe(1)
		expect(clampFadeSeconds(13)).toBe(12)
		expect(clampFadeSeconds(2.5)).toBe(3)
		expect(clampFadeSeconds(Number.NaN)).toBe(6)
		expect(clampFadeSeconds(undefined)).toBe(6)
	})

	it("falls back per field: an unknown skip mode is a cut, absent fields are the defaults", () => {
		expect(normalizeSmoothTransitionsPrefs({ manualTransition: "crossfade", fadeSeconds: 9 })).toEqual({
			...DEFAULT_SMOOTH_TRANSITIONS_PREFS,
			fadeSeconds: 9
		})
		expect(normalizeSmoothTransitionsPrefs({})).toEqual(DEFAULT_SMOOTH_TRANSITIONS_PREFS)
	})

	it("defaults to off, a 6 s fade, cut skips and matched loudness", () => {
		expect(DEFAULT_SMOOTH_TRANSITIONS_PREFS).toEqual({ enabled: false, fadeSeconds: 6, manualTransition: "cut", matchLoudness: true })
	})

	it("applies at once and persists in its own row, leaving the shuffle and loop prefs alone", async () => {
		fakeStore.set("audio.v1.prefs", JSON.stringify({ shuffleEnabled: true, loopMode: "all" }))

		toggleSmoothTransitions()
		setSmoothTransitionsPrefs({ fadeSeconds: 40 })

		expect(useSmoothTransitionsStore.getState().prefs).toEqual({ ...DEFAULT_SMOOTH_TRANSITIONS_PREFS, enabled: true, fadeSeconds: 12 })

		await flush()

		expect(JSON.parse(fakeStore.get(SMOOTH_TRANSITIONS_PREFS_KEY) ?? "null")).toEqual({
			...DEFAULT_SMOOTH_TRANSITIONS_PREFS,
			enabled: true,
			fadeSeconds: 12
		})
		expect(JSON.parse(fakeStore.get("audio.v1.prefs") ?? "null")).toEqual({ shuffleEnabled: true, loopMode: "all" })
	})

	it("keeps the device gate over any runtime cause", () => {
		setSmoothTransitionsUnavailable("degraded")

		expect(useSmoothTransitionsStore.getState().unavailable).toBe("degraded")

		useSmoothTransitionsStore.setState({ unavailable: "appleMobileGated" })
		setSmoothTransitionsUnavailable(null)

		expect(useSmoothTransitionsStore.getState().unavailable).toBe("appleMobileGated")
	})

	it("gates Apple mobile until the hardware gate passes", () => {
		expect(smoothTransitionsAvailabilityFor(true, false)).toBe("appleMobileGated")
		expect(smoothTransitionsAvailabilityFor(true, true)).toBe("available")
		expect(smoothTransitionsAvailabilityFor(false, false)).toBe("available")
	})
})
