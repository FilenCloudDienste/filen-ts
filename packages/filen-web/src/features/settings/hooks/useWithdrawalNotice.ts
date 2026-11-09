import type { UserAccountSubs } from "@filen/sdk-rs"
import { eligibleWithdrawals, withdrawalEndsAt } from "@/features/settings/lib/billing"
import { useBillingClock } from "@/features/settings/hooks/useBillingClock"
import { formatShortDate } from "@/lib/formatDate"

export interface WithdrawalNotice {
	// The contract whose window closes first.
	sub: UserAccountSubs
	// Its last day, formatted.
	until: string
}

// The account menu's withdrawal entry: present while any window is open, gone the moment the last one closes.
export function useWithdrawalNotice(subs: readonly UserAccountSubs[]): { now: number; notice: WithdrawalNotice | undefined } {
	const now = useBillingClock(subs)
	const sub = eligibleWithdrawals(subs, now)[0]
	const endsAt = sub === undefined ? undefined : withdrawalEndsAt(sub)

	return { now, notice: sub === undefined || endsAt === undefined ? undefined : { sub, until: formatShortDate(endsAt - 1) } }
}
