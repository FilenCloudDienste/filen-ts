/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { DEFAULT_THEME_SETTING, isThemeSetting, type ThemeSetting } from "@filen/shared"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { syncTitleBarColors } from "@/lib/desktop"

export type Theme = ThemeSetting
type ResolvedTheme = "dark" | "light"

interface ThemeProviderState {
	theme: Theme
	setTheme: (theme: Theme) => void
	toggleTheme: () => void
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"
const STORAGE_KEY = "theme"

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined)

function getSystemTheme(): ResolvedTheme {
	if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
		return "dark"
	}

	return "light"
}

export function resolveTheme(theme: Theme): ResolvedTheme {
	return theme === "system" ? getSystemTheme() : theme
}

// The other look than the one shown. When that is the system's own, the setting goes back to following the system,
// so toggling twice returns to where it started.
export function toggledTheme(current: Theme, system: ResolvedTheme): Theme {
	const shown = current === "system" ? system : current
	const next = shown === "dark" ? "light" : "dark"

	return next === system ? "system" : next
}

function disableTransitionsTemporarily() {
	const style = document.createElement("style")
	style.appendChild(document.createTextNode("*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"))
	document.head.appendChild(style)

	return () => {
		window.getComputedStyle(document.body)
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				style.remove()
			})
		})
	}
}

function applyTheme(nextTheme: Theme) {
	const root = document.documentElement
	const resolvedTheme = resolveTheme(nextTheme)
	const restoreTransitions = disableTransitionsTemporarily()

	root.classList.remove("light", "dark")
	root.classList.add(resolvedTheme)
	syncTitleBarColors()
	restoreTransitions()
}

// Site data can be blocked for the origin, and this provider renders above BootGate, which routes that case to
// /no-opfs: reading falls back to the default and writing is best effort, as in public/theme.js.
export function readStoredTheme(): Theme {
	try {
		const storedTheme = localStorage.getItem(STORAGE_KEY)

		if (isThemeSetting(storedTheme)) {
			return storedTheme
		}
	} catch {
		// Storage unavailable: the default applies.
	}

	return DEFAULT_THEME_SETTING
}

export function storeTheme(theme: Theme): void {
	try {
		localStorage.setItem(STORAGE_KEY, theme)
	} catch {
		// Storage unavailable or full: the theme applies for this page only.
	}
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setThemeState] = React.useState<Theme>(readStoredTheme)

	const setTheme = (nextTheme: Theme) => {
		storeTheme(nextTheme)
		setThemeState(nextTheme)
	}

	const toggleTheme = () => {
		setTheme(toggledTheme(theme, getSystemTheme()))
	}

	React.useEffect(() => {
		applyTheme(theme)

		if (theme !== "system") {
			return undefined
		}

		const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY)
		const handleChange = () => {
			applyTheme("system")
		}

		mediaQuery.addEventListener("change", handleChange)

		return () => {
			mediaQuery.removeEventListener("change", handleChange)
		}
	}, [theme])

	// "app.toggleTheme" (default combo "d"): modifier-held presses and editable-target focus
	// (input/textarea/select/contenteditable/ARIA textbox roles) are excluded by react-hotkeys-hook's
	// combo-matching and `enableOnFormTags`/`enableOnContentEditable` defaults (both false), and
	// `useAction`'s default `ignoreEventWhen` drops key-repeat. Combo-matching alone does NOT cover a
	// READ-ONLY surface with focus (e.g. the preview overlay's rendered-markdown or read-only-CodeMirror
	// panes: neither is a form tag, and neither sets `contenteditable`), so this provider — mounted above
	// the whole app, outside the drive feature's own isDialogOpen chain — additionally stands down under
	// any open dialog or menu (OUTSIDE_OVERLAYS, the shared Base UI signal in dialogGuard.ts), which
	// catches the preview overlay the same way it catches every other dialog.
	useAction(
		"app.toggleTheme",
		() => {
			toggleTheme()
		},
		OUTSIDE_OVERLAYS
	)
	// A choice rather than a flip, so a key always lands on the same theme; unassigned until a user binds them.
	useAction(
		"app.themeLight",
		() => {
			setTheme("light")
		},
		OUTSIDE_OVERLAYS
	)
	useAction(
		"app.themeDark",
		() => {
			setTheme("dark")
		},
		OUTSIDE_OVERLAYS
	)
	useAction(
		"app.themeSystem",
		() => {
			setTheme("system")
		},
		OUTSIDE_OVERLAYS
	)

	React.useEffect(() => {
		const handleStorageChange = (event: StorageEvent) => {
			// Keyed on the name alone: reading `localStorage` itself throws when site data is blocked.
			if (event.key !== STORAGE_KEY) {
				return
			}

			if (isThemeSetting(event.newValue)) {
				setThemeState(event.newValue)
				return
			}

			setThemeState(DEFAULT_THEME_SETTING)
		}

		window.addEventListener("storage", handleStorageChange)

		return () => {
			window.removeEventListener("storage", handleStorageChange)
		}
	}, [])

	return <ThemeProviderContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeProviderContext.Provider>
}

export const useTheme = () => {
	const context = React.useContext(ThemeProviderContext)

	if (context === undefined) {
		throw new Error("useTheme must be used within a ThemeProvider")
	}

	return context
}
