import { useId, useState, type ReactNode } from "react"
import { Trans, useTranslation } from "react-i18next"
import { toast } from "sonner"
import { cn } from "@filen/shared"
import { CreditCardIcon } from "lucide-react"
import type { SettingsKey } from "@/lib/i18n"
import { FILEN_PRIVACY_URL, FILEN_TERMS_URL } from "@/lib/externalUrls"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { useRemotePricingQuery } from "@/features/settings/lib/remoteConfig"
import {
	currentPlanIds,
	groupPlans,
	initialPlanTab,
	purchasesEnabled,
	tabSavings,
	type PaymentMethod,
	type PlanTab
} from "@/features/settings/lib/plans"
import { billingErrorLabel, createCheckout } from "@/features/settings/lib/billingActions"
import { PlanCard, type PlanPurchase } from "@/features/settings/components/billing/planCard"
import { PersonalInfoDialog } from "@/features/settings/components/account/personalInfoRow"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LoadingState } from "@/components/loadingState"
import { EmptyMessage } from "@/components/emptyMessage"

const TAB_KEYS: Record<PlanTab, SettingsKey> = {
	monthly: "settingsBillingTabMonthly",
	annually: "settingsBillingTabAnnually",
	starter: "settingsBillingTabStarter",
	lifetime: "settingsBillingTabLifetime"
}

interface PlansViewProps {
	accountQuery: AccountQuerySuccess
	// A plan to open on (a pricing-page link).
	planId: number | undefined
}

interface Purchase {
	planId: number
	method: PaymentMethod
	state: PlanPurchase
}

const IDLE: PlanPurchase = { status: "idle" }

// Trans puts the link text in as children.
function LegalLink({ href, children }: { href: string; children?: ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="rounded-sm text-foreground underline underline-offset-4 focus-ring outline-none hover:decoration-2"
		>
			{children}
		</a>
	)
}

// Prices come from the remote config the shell already holds; nothing here reads the network until Buy.
function PlansView({ accountQuery, planId }: PlansViewProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const pricingQuery = useRemotePricingQuery()
	const [tab, setTab] = useState<PlanTab | null>(null)
	const [purchase, setPurchase] = useState<Purchase | null>(null)
	// A purchase waiting for a country (VAT), resumed once the personal information is saved.
	const [countryGate, setCountryGate] = useState<{ planId: number; method: PaymentMethod } | null>(null)
	const pricing = pricingQuery.data
	const savingsId = useId()

	async function startPurchase(target: { planId: number; method: PaymentMethod }): Promise<void> {
		setPurchase({ ...target, state: { status: "pending" } })

		const outcome = await createCheckout(target.planId, target.method)

		if (outcome.status === "error") {
			setPurchase(null)
			toast.error(billingErrorLabel(outcome.dto))

			return
		}

		setPurchase({ ...target, state: { status: "ready", url: outcome.item } })
	}

	function buy(target: { planId: number; method: PaymentMethod }): void {
		const country = accountQuery.data.personal.country?.trim() ?? ""

		if (country === "") {
			setCountryGate(target)

			return
		}

		void startPurchase(target)
	}

	if (pricing === undefined) {
		return <LoadingState size="lg" />
	}

	if (pricing === null) {
		return (
			<EmptyMessage
				icon={CreditCardIcon}
				title={t("settingsBillingPlansLoadError")}
			>
				<Button
					variant="outline"
					disabled={pricingQuery.isFetching}
					onClick={() => {
						void pricingQuery.refetch()
					}}
				>
					{t("common:tryAgain")}
				</Button>
			</EmptyMessage>
		)
	}

	const groups = groupPlans(pricing)
	const activeTab = tab ?? initialPlanTab(groups, planId)
	// One-time purchases never renew, so their cards get their own terms; a tab can hold both kinds (Starter).
	const activeCards = groups.find(group => group.tab === activeTab)?.cards ?? []
	const showsOneTime = activeCards.some(card => card.plan.term === "lifetime")
	const showsRecurring = activeCards.length === 0 || activeCards.some(card => card.plan.term !== "lifetime")
	const owned = currentPlanIds(accountQuery.data.subs)
	// The config is never restored from disk, but a stale copy is re-read on open: Buy waits for that read.
	const refreshing = pricingQuery.isStale && pricingQuery.isFetching
	const buyDisabledReason = !purchasesEnabled()
		? t("settingsBillingBuyDevDisabled")
		: !isOnline
			? t("common:offlineActionDisabled")
			: refreshing
				? t("settingsBillingBuyLoadingPrices")
				: undefined
	const busy = purchase?.state.status === "pending"

	return (
		<div className="@container/plans flex flex-col gap-8">
			{groups.length === 0 || activeTab === undefined ? (
				<EmptyMessage
					icon={CreditCardIcon}
					title={t("settingsBillingPlansEmpty")}
				/>
			) : (
				<Tabs
					value={activeTab}
					onValueChange={value => {
						const next = groups.find(group => group.tab === value)

						if (next !== undefined) {
							setTab(next.tab)
						}
					}}
				>
					<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
						<TabsList className="h-9! max-w-full overflow-x-auto">
							{groups.map(group => {
								const savings = group.tab === "annually" ? tabSavings(group.cards) : undefined

								return (
									<TabsTrigger
										key={group.tab}
										value={group.tab}
										className="px-3.5"
										// The hint is the tab's description, so its name stays the plain term.
										aria-describedby={savings === undefined ? undefined : savingsId}
									>
										{t(TAB_KEYS[group.tab])}
										{savings === undefined ? null : (
											<span
												id={savingsId}
												aria-hidden="true"
												className="rounded-full bg-primary/10 px-1.5 text-xs font-medium text-foreground tabular-nums"
											>
												{t(savings.upTo ? "settingsBillingSaveUpToPercent" : "settingsBillingSavePercent", {
													percent: savings.percent
												})}
											</span>
										)}
									</TabsTrigger>
								)
							})}
						</TabsList>
						{buyDisabledReason === undefined ? null : (
							<p
								role="status"
								className="text-sm text-muted-foreground"
							>
								{buyDisabledReason}
							</p>
						)}
					</div>
					{groups.map(group => (
						<TabsContent
							key={group.tab}
							value={group.tab}
							className={cn(
								"grid grid-cols-1 items-stretch gap-4 pt-4 @xl/plans:grid-cols-2",
								group.cards.length >= 4 ? "@5xl/plans:grid-cols-4" : "@5xl/plans:grid-cols-3"
							)}
						>
							{group.cards.map(card => (
								<PlanCard
									key={card.plan.id}
									card={card}
									current={owned.has(card.plan.id)}
									highlighted={card.plan.id === planId}
									purchase={purchase !== null && purchase.planId === card.plan.id ? purchase.state : IDLE}
									buyDisabledReason={buyDisabledReason}
									locked={busy}
									onBuy={method => {
										buy({ planId: card.plan.id, method })
									}}
								/>
							))}
						</TabsContent>
					))}
				</Tabs>
			)}
			<div className="flex max-w-3xl flex-col gap-1.5 border-t border-border/60 pt-4 text-xs leading-relaxed text-muted-foreground">
				{showsRecurring ? <p>{t("settingsBillingLegalRenewal")}</p> : null}
				{showsOneTime ? <p>{t("settingsBillingLegalOneTime")}</p> : null}
				<p>
					<Trans
						t={t}
						i18nKey="settingsBillingLegalAgreement"
						components={{
							terms: <LegalLink href={FILEN_TERMS_URL} />,
							privacy: <LegalLink href={FILEN_PRIVACY_URL} />
						}}
					/>
				</p>
			</div>
			<PersonalInfoDialog
				open={countryGate !== null}
				accountQuery={accountQuery}
				notice={t("settingsBillingCountryRequired")}
				requireCountry
				onOpenChange={next => {
					if (!next) {
						setCountryGate(null)
					}
				}}
				onSaved={personal => {
					const target = countryGate

					setCountryGate(null)

					if (target !== null && (personal.country?.trim() ?? "") !== "") {
						void startPurchase(target)
					}
				}}
			/>
		</div>
	)
}

export { PlansView }
