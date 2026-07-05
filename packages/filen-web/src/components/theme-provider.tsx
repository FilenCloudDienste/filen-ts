/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"

type Theme = "dark" | "light" | "system"
type ResolvedTheme = "dark" | "light"

interface ThemeProviderProps {
	children: React.ReactNode
	defaultTheme?: Theme
	storageKey?: string
	disableTransitionOnChange?: boolean
}

interface ThemeProviderState {
	theme: Theme
	setTheme: (theme: Theme) => void
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"
const THEME_VALUES: Theme[] = ["dark", "light", "system"]

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined)

function isTheme(value: string | null): value is Theme {
	if (value === null) {
		return false
	}

	return THEME_VALUES.includes(value as Theme)
}

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

// Module scope, not inside the component: runs exactly once per module evaluation, which is what
// `registerAction`'s duplicate-id guard assumes. React StrictMode's double-invocation only
// affects render/effects, not top-level module code, so this is safe under StrictMode — the one
// known edge is Vite/React-Fast-Refresh re-running this file's top level on an HMR edit to THIS
// file specifically, which would throw on the second registration; accepted for slice-0 (a
// manual browser refresh recovers), same trade-off i18n's module-scope `.init()` already makes.
registerAction({
	id: "app.toggleTheme",
	defaultCombo: "d",
	scope: "global",
	descriptionKey: "toggleTheme"
})

export function ThemeProvider({
	children,
	defaultTheme = "system",
	storageKey = "theme",
	disableTransitionOnChange = true,
	...props
}: ThemeProviderProps) {
	const [theme, setThemeState] = React.useState<Theme>(() => {
		const storedTheme = localStorage.getItem(storageKey)
		if (isTheme(storedTheme)) {
			return storedTheme
		}

		return defaultTheme
	})

	const setTheme = React.useCallback(
		(nextTheme: Theme) => {
			localStorage.setItem(storageKey, nextTheme)
			setThemeState(nextTheme)
		},
		[storageKey]
	)

	const applyTheme = React.useCallback(
		(nextTheme: Theme) => {
			const root = document.documentElement
			const resolvedTheme = nextTheme === "system" ? getSystemTheme() : nextTheme
			const restoreTransitions = disableTransitionOnChange ? disableTransitionsTemporarily() : null

			root.classList.remove("light", "dark")
			root.classList.add(resolvedTheme)

			if (restoreTransitions) {
				restoreTransitions()
			}
		},
		[disableTransitionOnChange]
	)

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
	}, [theme, applyTheme])

	// Registered above as "app.toggleTheme" (default combo "d") — modifier-held presses and
	// editable-target focus (input/textarea/select/contenteditable/ARIA textbox roles) are already
	// excluded by react-hotkeys-hook's own combo-matching and `enableOnFormTags`/
	// `enableOnContentEditable` defaults (both false), and `useAction`'s default `ignoreEventWhen`
	// drops key-repeat — together the same guards the old hand-rolled listener implemented itself.
	useAction(
		"app.toggleTheme",
		() => {
			setThemeState(currentTheme => {
				const nextTheme =
					currentTheme === "dark" ? "light" : currentTheme === "light" ? "dark" : getSystemTheme() === "dark" ? "light" : "dark"

				localStorage.setItem(storageKey, nextTheme)
				return nextTheme
			})
		},
		undefined,
		[storageKey]
	)

	React.useEffect(() => {
		const handleStorageChange = (event: StorageEvent) => {
			if (event.storageArea !== localStorage) {
				return
			}

			if (event.key !== storageKey) {
				return
			}

			if (isTheme(event.newValue)) {
				setThemeState(event.newValue)
				return
			}

			setThemeState(defaultTheme)
		}

		window.addEventListener("storage", handleStorageChange)

		return () => {
			window.removeEventListener("storage", handleStorageChange)
		}
	}, [defaultTheme, storageKey])

	const value = React.useMemo(
		() => ({
			theme,
			setTheme
		}),
		[theme, setTheme]
	)

	return (
		<ThemeProviderContext.Provider
			{...props}
			value={value}
		>
			{children}
		</ThemeProviderContext.Provider>
	)
}

export const useTheme = () => {
	const context = React.useContext(ThemeProviderContext)

	if (context === undefined) {
		throw new Error("useTheme must be used within a ThemeProvider")
	}

	return context
}
