import { useEffect, useState } from "react"
import type { UserAccountSubs } from "@filen/sdk-rs"
import { nextBillingChange } from "@/features/settings/lib/billing"

// setTimeout's ceiling; a later change simply re-arms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1

// "Now" for billing eligibility, moved forward only when a withdrawal window closes or a cancel becomes available:
// one timer for the nearest such moment, never an interval.
export function useBillingClock(subs: readonly UserAccountSubs[]): number {
	const [now, setNow] = useState(() => Date.now())
	const next = nextBillingChange(subs, now)

	useEffect(() => {
		if (next === undefined) {
			return
		}

		const timer = setTimeout(
			() => {
				setNow(Date.now())
			},
			Math.min(Math.max(next - Date.now() + 1, 0), MAX_TIMEOUT_MS)
		)

		return () => {
			clearTimeout(timer)
		}
	}, [next, now])

	return now
}
