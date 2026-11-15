import { useEffect, useEffectEvent, useRef } from "react"
import { loadTurnstile } from "@/features/publicLinks/lib/turnstile"

const TURNSTILE_SITE_KEY = "0x4AAAAAACawxjW53JMJX6Sa"

// The report dialog's Cloudflare Turnstile challenge (an invisible widget). It reports each token it gets, null
// when one expires or the challenge fails, and `onError` when it cannot run. A token is single-use: the dialog
// remounts this after a failed send. The widget goes with it.
export function ReportChallenge({ onToken, onError }: { onToken: (token: string | null) => void; onError: () => void }) {
	const container = useRef<HTMLDivElement>(null)
	const reportToken = useEffectEvent((token: string | null) => {
		onToken(token)
	})
	const reportError = useEffectEvent(() => {
		onError()
	})

	useEffect(() => {
		let widgetId: string | null = null
		let cancelled = false

		void loadTurnstile()
			.then(turnstile => {
				const element = container.current

				if (cancelled || element === null) {
					return
				}

				widgetId =
					turnstile.render(element, {
						sitekey: TURNSTILE_SITE_KEY,
						action: "abuse-report",
						retry: "auto",
						"refresh-expired": "auto",
						callback: token => {
							reportToken(token)
						},
						"expired-callback": () => {
							reportToken(null)
						},
						"error-callback": () => {
							reportToken(null)
							reportError()
						}
					}) ?? null
			})
			.catch(() => {
				if (!cancelled) {
					reportError()
				}
			})

		return () => {
			cancelled = true

			if (widgetId !== null) {
				window.turnstile?.remove(widgetId)
			}
		}
	}, [])

	return <div ref={container} />
}
