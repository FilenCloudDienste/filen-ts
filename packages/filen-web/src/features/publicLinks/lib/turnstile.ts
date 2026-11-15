// A minimal typed wrapper over Cloudflare Turnstile's explicit-render API, loaded only when first needed.

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

export interface TurnstileRenderOptions {
	sitekey: string
	action: string
	retry: "auto" | "never"
	"refresh-expired": "auto" | "manual" | "never"
	callback: (token: string) => void
	"expired-callback": () => void
	"error-callback": (code: string) => void
}

export interface TurnstileApi {
	render: (container: HTMLElement, options: TurnstileRenderOptions) => string | null | undefined
	reset: (widgetId: string) => void
	remove: (widgetId: string) => void
}

declare global {
	interface Window {
		turnstile?: TurnstileApi
	}
}

let loading: Promise<TurnstileApi> | null = null

// Appends the script once and reuses it. A failed load is forgotten, so the next call tries again.
export function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile !== undefined) {
		return Promise.resolve(window.turnstile)
	}

	loading ??= new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script")

		script.src = TURNSTILE_SCRIPT_URL
		script.async = true
		script.onload = () => {
			if (window.turnstile === undefined) {
				reject(new Error("Turnstile script loaded without its API"))
			} else {
				resolve(window.turnstile)
			}
		}
		script.onerror = () => {
			script.remove()
			reject(new Error("Turnstile script failed to load"))
		}

		document.head.append(script)
	}).catch((e: unknown) => {
		loading = null

		throw e
	})

	return loading
}
