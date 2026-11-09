import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { UserAccountSubs } from "@filen/sdk-rs"
import { formatBytes } from "@filen/shared"
import { ArrowUpRightIcon, WalletIcon } from "lucide-react"
import {
	cancelAvailableFrom,
	formatBillingCost,
	isCancellable,
	isRecurringStripe,
	isWithdrawalEligible,
	STRIPE_BILLING_PORTAL_URL,
	subscriptionStatus,
	SUBSCRIPTION_STATUS_META,
	toMillis,
	withdrawalEndsAt
} from "@/features/settings/lib/billing"
import { billingErrorLabel, cancelSubscription } from "@/features/settings/lib/billingActions"
import { useBillingClock } from "@/features/settings/hooks/useBillingClock"
import { formatDateTime, formatShortDate } from "@/lib/formatDate"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { SettingsTableBlock } from "@/features/settings/components/billing/billingTable"
import { WithdrawalDialog } from "@/features/settings/components/billing/withdrawalDialog"

interface SubscriptionsBlockProps {
	accountQuery: AccountQuerySuccess
}

// FREE-account reality: `subs` is empty on the shared e2e account — the empty state IS the e2e
// assertion for this block, never populated rows. Web only: the desktop app manages billing on the web.
function SubscriptionsBlock({ accountQuery }: SubscriptionsBlockProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const subs = accountQuery.data.subs
	const now = useBillingClock(subs)
	const [cancelTarget, setCancelTarget] = useState<UserAccountSubs | null>(null)
	const [cancelPending, setCancelPending] = useState(false)
	const [withdrawOpen, setWithdrawOpen] = useState(false)
	const [withdrawSubId, setWithdrawSubId] = useState<string | undefined>(undefined)
	const offlineReason = isOnline ? undefined : t("common:offlineActionDisabled")

	async function handleCancel(sub: UserAccountSubs): Promise<void> {
		setCancelPending(true)

		const outcome = await cancelSubscription(sub)

		setCancelPending(false)

		if (outcome.status === "error") {
			toast.error(billingErrorLabel(outcome.dto))

			return
		}

		toast.success(t("settingsBillingCancelSuccess"))
		setCancelTarget(null)
	}

	function actions(sub: UserAccountSubs) {
		const cancellable = isCancellable(sub)
		const cancelFrom = cancellable ? cancelAvailableFrom(sub, now) : undefined
		const withdrawable = isWithdrawalEligible(sub, now)
		const endsAt = withdrawable ? withdrawalEndsAt(sub) : undefined

		return (
			<div className="flex flex-wrap items-center justify-end gap-2">
				{withdrawable && endsAt !== undefined ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!isOnline}
						title={offlineReason}
						onClick={() => {
							setWithdrawSubId(sub.id)
							setWithdrawOpen(true)
						}}
					>
						{t("settingsBillingWithdraw")}
						<span className="text-muted-foreground">
							{t("settingsBillingWithdrawUntil", { date: formatShortDate(endsAt - 1) })}
						</span>
					</Button>
				) : null}
				{isRecurringStripe(sub) && sub.activated ? (
					<a
						href={STRIPE_BILLING_PORTAL_URL}
						target="_blank"
						rel="noopener noreferrer"
						className={buttonVariants({ variant: "ghost", size: "sm" })}
					>
						{t("settingsBillingDetails")}
						<ArrowUpRightIcon
							aria-hidden="true"
							data-icon="inline-end"
						/>
					</a>
				) : null}
				{cancellable ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={!isOnline || cancelFrom !== undefined}
						title={offlineReason}
						aria-describedby={cancelFrom === undefined ? undefined : `cancel-from-${sub.id}`}
						onClick={() => {
							setCancelTarget(sub)
						}}
					>
						{t("settingsBillingCancelAction")}
					</Button>
				) : null}
				{cancelFrom === undefined ? null : (
					<span
						id={`cancel-from-${sub.id}`}
						className="text-xs text-muted-foreground"
					>
						{t("settingsBillingCancelAvailableFrom", { date: formatDateTime(cancelFrom) })}
					</span>
				)}
			</div>
		)
	}

	return (
		<>
			<SettingsTableBlock
				rows={subs}
				rowKey={sub => sub.id}
				columns={[
					{ header: t("settingsBillingColumnPlan"), cell: sub => sub.planName },
					{ header: t("settingsBillingColumnStorage"), className: "tabular-nums", cell: sub => formatBytes(Number(sub.storage)) },
					{ header: t("settingsBillingColumnCost"), className: "tabular-nums", cell: sub => formatBillingCost(sub.planCost) },
					{
						header: t("settingsBillingColumnStarted"),
						className: "tabular-nums",
						cell: sub => {
							const start = toMillis(sub.startTimestamp)

							return start === undefined ? "—" : formatShortDate(start)
						}
					},
					{
						header: t("settingsBillingColumnStatus"),
						cell: sub => {
							const meta = SUBSCRIPTION_STATUS_META[subscriptionStatus(sub)]
							const withdrawnAt = toMillis(sub.withdrawRequested)

							return (
								<div className="flex flex-col items-start gap-1">
									<Badge variant={meta.badge}>{t(meta.labelKey)}</Badge>
									{withdrawnAt === undefined ? null : (
										<span className="text-xs text-muted-foreground">
											{t("settingsBillingWithdrawalReceived", { date: formatDateTime(withdrawnAt) })}
										</span>
									)}
								</div>
							)
						}
					},
					{ header: t("settingsBillingColumnActions"), className: "text-right", cell: actions }
				]}
				empty={{
					icon: WalletIcon,
					title: t("settingsBillingSubscriptionsEmptyTitle"),
					description: t("settingsBillingSubscriptionsEmptyDescription")
				}}
			/>
			<ConfirmDialog
				open={cancelTarget !== null}
				pending={cancelPending}
				title={t("settingsBillingCancelConfirmTitle")}
				body={t("settingsBillingCancelConfirmBody", { plan: cancelTarget?.planName ?? "" })}
				confirmLabel={t("settingsBillingCancelConfirm")}
				cancelLabel={t("settingsBillingCancelKeep")}
				destructive
				onOpenChange={next => {
					if (!next) {
						setCancelTarget(null)
					}
				}}
				onConfirm={() => {
					if (cancelTarget !== null) {
						void handleCancel(cancelTarget)
					}
				}}
			/>
			<WithdrawalDialog
				open={withdrawOpen}
				account={accountQuery.data}
				now={now}
				subId={withdrawSubId}
				onOpenChange={setWithdrawOpen}
			/>
		</>
	)
}

export { SubscriptionsBlock }
