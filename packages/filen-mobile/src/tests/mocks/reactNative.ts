/**
 * Minimal mock of react-native for Vitest.
 *
 * Vite/Rollup cannot parse the real react-native/index.js (Flow syntax),
 * so this mock is resolved via a Vitest alias to prevent the real module
 * from ever being loaded.
 *
 * Only the APIs actually used by tested modules are implemented here.
 * Add more as needed.
 */

export const Platform = {
	OS: "ios" as "ios" | "android",
	select<T>(specifics: { ios?: T; android?: T; default?: T }): T | undefined {
		return specifics[this.OS] ?? specifics["default"]
	}
}
