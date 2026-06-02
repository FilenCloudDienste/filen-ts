import { Uniwind } from "uniwind"
import secureStore, { useSecureStore } from "@/lib/secureStore"

export const THEME_SECURE_STORE_KEY = "appearance.theme"

// "system" follows the device appearance (uniwind's adaptive mode, auto-updates on OS change);
// "light"/"dark" are fixed overrides. Mirrors the language preference: default to system, persist
// a manual override.
export const THEME_SETTINGS = ["system", "light", "dark"] as const

export type ThemeSetting = (typeof THEME_SETTINGS)[number]

export const DEFAULT_THEME_SETTING: ThemeSetting = "system"

function isThemeSetting(value: string | null | undefined): value is ThemeSetting {
	return value !== null && value !== undefined && (THEME_SETTINGS as readonly string[]).includes(value)
}

export function useThemeSetting(): [ThemeSetting, (next: ThemeSetting | ((prev: ThemeSetting) => ThemeSetting)) => void] {
	return useSecureStore<ThemeSetting>(THEME_SECURE_STORE_KEY, DEFAULT_THEME_SETTING)
}

// Side-effects ONLY. Applies the setting to uniwind's runtime — which resolves the active theme,
// re-renders every `useUniwind()`/className consumer, drives RN's `Appearance.setColorScheme`, and
// follows the OS while in "system" mode. Persistence is owned by `setThemeSetting`/`useSecureStore`
// (mirrors `changeAppLanguage` — calling this must NOT write to secureStore, or it double-persists).
export function changeAppTheme(setting: ThemeSetting): void {
	Uniwind.setTheme(setting)
}

// Resolves the theme setting to apply on boot: persisted (secureStore) → DEFAULT_THEME_SETTING.
export async function getInitialThemeSetting(): Promise<ThemeSetting> {
	const persisted = await secureStore.get<ThemeSetting>(THEME_SECURE_STORE_KEY)

	return isThemeSetting(persisted) ? persisted : DEFAULT_THEME_SETTING
}

// Applies the persisted theme before first paint. uniwind already defaults to the system appearance
// on import, so this only diverges when the user picked a fixed override — but `setTheme("system")`
// is idempotent, so it is always safe to apply.
export async function initTheme(): Promise<void> {
	changeAppTheme(await getInitialThemeSetting())
}
