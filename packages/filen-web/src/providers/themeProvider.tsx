/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { DEFAULT_THEME_SETTING, isThemeSetting, type ThemeSetting } from "@filen/shared"
import { useAction } from "@/lib/keymap/useAction"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"

export type Theme = ThemeSetting
type ResolvedTheme = "dark" | "light"

interface ThemeProviderState {
	theme: Theme
	setTheme: (theme: Theme) => void
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
	const resolvedTheme = nextTheme === "system" ? getSystemTheme() : nextTheme
	const restoreTransitions = disableTransitionsTemporarily()

	root.classList.remove("light", "dark")
	root.classList.add(resolvedTheme)
	restoreTransitions()
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setThemeState] = React.useState<Theme>(() => {
		const storedTheme = localStorage.getItem(STORAGE_KEY)
		if (isThemeSetting(storedTheme)) {
			return storedTheme
		}

		return DEFAULT_THEME_SETTING
	})

	const setTheme = (nextTheme: Theme) => {
		localStorage.setItem(STORAGE_KEY, nextTheme)
		setThemeState(nextTheme)
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

	// Registered above as "app.toggleTheme" (default combo "d") — modifier-held presses and
	// editable-target focus (input/textarea/select/contenteditable/ARIA textbox roles) are already
	// excluded by react-hotkeys-hook's own combo-matching and `enableOnFormTags`/
	// `enableOnContentEditable` defaults (both false), and `useAction`'s default `ignoreEventWhen`
	// drops key-repeat — together the same guards the old hand-rolled listener implemented itself.
	// That combo-matching alone does NOT cover a READ-ONLY surface with focus (e.g. the preview
	// overlay's rendered-markdown or read-only-CodeMirror panes: neither is a form tag, and neither
	// sets `contenteditable`), so this provider — mounted above the whole app, outside the drive
	// feature's own isDialogOpen chain (directoryListing.tsx/useDriveDialogHost.tsx) — additionally
	// guards on isAnyDialogOpen(), the shared Base UI signal (see dialogGuard.ts) that catches the
	// preview overlay the same way it catches every other modal dialog.
	useAction("app.toggleTheme", () => {
		if (isAnyDialogOpen()) {
			return
		}

		setThemeState(currentTheme => {
			const nextTheme =
				currentTheme === "dark" ? "light" : currentTheme === "light" ? "dark" : getSystemTheme() === "dark" ? "light" : "dark"

			localStorage.setItem(STORAGE_KEY, nextTheme)
			return nextTheme
		})
	})

	React.useEffect(() => {
		const handleStorageChange = (event: StorageEvent) => {
			if (event.storageArea !== localStorage) {
				return
			}

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

	return <ThemeProviderContext.Provider value={{ theme, setTheme }}>{children}</ThemeProviderContext.Provider>
}

export const useTheme = () => {
	const context = React.useContext(ThemeProviderContext)

	if (context === undefined) {
		throw new Error("useTheme must be used within a ThemeProvider")
	}

	return context
}
