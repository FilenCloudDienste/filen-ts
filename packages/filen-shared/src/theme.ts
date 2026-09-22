// "system" follows the OS appearance and re-resolves whenever it changes; "light"/"dark" are fixed
// overrides. Order is UI order too — mobile's appearance picker renders directly off this list.
export const THEME_SETTINGS = ["system", "light", "dark"] as const

export type ThemeSetting = (typeof THEME_SETTINGS)[number]

export const DEFAULT_THEME_SETTING: ThemeSetting = "system"

// `string | null | undefined` is a strict superset of both real callers: secureStore.get resolves
// `T | null`, localStorage.getItem returns `string | null`.
export function isThemeSetting(value: string | null | undefined): value is ThemeSetting {
	return value !== null && value !== undefined && (THEME_SETTINGS as readonly string[]).includes(value)
}
