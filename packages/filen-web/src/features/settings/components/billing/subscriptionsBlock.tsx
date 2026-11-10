import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { UserAccountSubs } from "@filen/sdk-rs"
import { formatBytes } from "@filen/shared"
import { ArrowUpRightIcon, FileXIcon, GemIcon, InfoIcon, WalletIcon } from "lucide-react"
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
import { planTermOf, PRICE_SUFFIX_KEYS } from "@/features/settings/lib/plans"
import { useRemotePricingQuery } from "@/features/settings/lib/remoteConfig"
import { useBillingClock } from "@/features/settings/hooks/useBillingClock"
import { formatDateTime, formatShortDate } from "@/lib/formatDate"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"
import { EmptyMessage } from "@/components/emptyMessage"
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
	// Only to name each subscription's term: the remote-config query the shell already holds, no request of its own.
	const pricing = useRemotePricingQuery().data
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

		const portal = isRecurringStripe(sub) && sub.activated

		if (!withdrawable && !portal && !cancellable) {
			return null
		}

		return (
			<>
				<Separator className="bg-border/60" />
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					{withdrawable && endsAt !== undefined ? (
						<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!isOnline}
								title={offlineReason}
								aria-describedby={`withdraw-until-${sub.id}`}
								onClick={() => {
									setWithdrawSubId(sub.id)
									setWithdrawOpen(true)
								}}
							>
								<FileXIcon
									aria-hidden="true"
									data-icon="inline-start"
								/>
								{t("settingsBillingWithdraw")}
							</Button>
							<span
								id={`withdraw-until-${sub.id}`}
								className="text-xs text-muted-foreground tabular-nums"
							>
								{t("settingsBillingWithdrawUntil", { date: formatShortDate(endsAt - 1) })}
							</span>
						</div>
					) : null}
					{portal || cancellable ? (
						<div className="ms-auto flex flex-wrap items-center justify-end gap-x-1 gap-y-1">
							{portal ? (
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
						</div>
					) : null}
				</div>
				{cancelFrom === undefined ? null : (
					<p
						id={`cancel-from-${sub.id}`}
						className="-mt-1 text-end text-xs text-muted-foreground"
					>
						{t("settingsBillingCancelAvailableFrom", { date: formatDateTime(cancelFrom) })}
					</p>
				)}
			</>
		)
	}

	// One item per subscription: a table squeezed its columns as soon as a row had actions.
	function card(sub: UserAccountSubs) {
		const meta = SUBSCRIPTION_STATUS_META[subscriptionStatus(sub)]
		const start = toMillis(sub.startTimestamp)
		const withdrawnAt = toMillis(sub.withdrawRequested)
		const term = planTermOf(pricing, sub.planId)
		const subActions = actions(sub)

		return (
			<li
				key={sub.id}
				className="flex flex-col gap-4 rounded-2xl border border-border/60 p-4"
			>
				<div className="flex items-start gap-3">
					<span
						aria-hidden="true"
						className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
					>
						<GemIcon className="size-5" />
					</span>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<h3 className="min-w-0 font-heading text-sm font-medium break-words">{sub.planName}</h3>
							<Badge variant={meta.badge}>{t(meta.labelKey)}</Badge>
						</div>
						<dl className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground tabular-nums">
							<dt className="sr-only">{t("settingsBillingColumnStorage")}</dt>
							<dd className="text-foreground">{formatBytes(Number(sub.storage))}</dd>
							<span aria-hidden="true">·</span>
							<dt className="sr-only">{t("settingsBillingColumnCost")}</dt>
							<dd>
								{formatBillingCost(sub.planCost)}
								{term === undefined ? null : ` ${t(PRICE_SUFFIX_KEYS[term])}`}
							</dd>
							{start === undefined ? null : (
								<>
									<span aria-hidden="true">·</span>
									<dt>{t("settingsBillingColumnStarted")}</dt>
									<dd>{formatShortDate(start)}</dd>
								</>
							)}
						</dl>
						{withdrawnAt === undefined ? null : (
							<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<InfoIcon
									aria-hidden="true"
									className="size-3.5 shrink-0"
								/>
								{t("settingsBillingWithdrawalReceived", { date: formatDateTime(withdrawnAt) })}
							</p>
						)}
					</div>
				</div>
				{subActions}
			</li>
		)
	}

	return (
		<>
			<SettingsBlock>
				{subs.length === 0 ? (
					<EmptyMessage
						className="rounded-none border-0 p-4"
						icon={WalletIcon}
						title={t("settingsBillingSubscriptionsEmptyTitle")}
						description={t("settingsBillingSubscriptionsEmptyDescription")}
					/>
				) : (
					<ul className="flex flex-col gap-3">{subs.map(card)}</ul>
				)}
			</SettingsBlock>
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
