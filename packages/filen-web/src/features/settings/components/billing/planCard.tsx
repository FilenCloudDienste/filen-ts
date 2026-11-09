import { useTranslation } from "react-i18next"
import { formatBytes, cn } from "@filen/shared"
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon } from "lucide-react"
import type { SettingsKey } from "@/lib/i18n"
import { formatBillingCost } from "@/features/settings/lib/billing"
import type { PaymentMethod, PlanCard as PlanCardModel } from "@/features/settings/lib/plans"
import type { PlanTerm } from "@/features/settings/lib/remoteConfig"
import { markAccountStale } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

const FEATURE_KEYS: readonly SettingsKey[] = [
	"settingsBillingFeatureBandwidth",
	"settingsBillingFeatureUploads",
	"settingsBillingFeatureEncryption",
	"settingsBillingFeatureZeroKnowledge",
	"settingsBillingFeatureSyncing",
	"settingsBillingFeatureNetworkDrive",
	"settingsBillingFeatureSharing",
	"settingsBillingFeatureNotes",
	"settingsBillingFeatureChats"
]

const TERM_KEYS: Record<PlanTerm, SettingsKey> = {
	monthly: "settingsBillingTermMonthly",
	annually: "settingsBillingTermAnnually",
	lifetime: "settingsBillingTermLifetime"
}

const PERIOD_KEYS: Record<PlanTerm, SettingsKey> = {
	monthly: "settingsBillingPricePerMonth",
	annually: "settingsBillingPricePerYear",
	lifetime: "settingsBillingPriceOnce"
}

const METHOD_KEYS: Record<PaymentMethod, SettingsKey> = {
	stripe: "settingsBillingMethodCard",
	paypal: "settingsBillingMethodPaypal",
	crypto: "settingsBillingMethodCrypto"
}

// The card's purchase state, owned by the plans view so one checkout runs at a time.
export type PlanPurchase = { status: "idle" } | { status: "pending" } | { status: "ready"; url: string }

interface PlanCardProps {
	card: PlanCardModel
	// The tab's name already says Starter; every other plan names its term.
	showTerm: boolean
	current: boolean
	highlighted: boolean
	purchase: PlanPurchase
	// Why Buy is off, undefined when it is on.
	buyDisabledReason: string | undefined
	// Another card's checkout is being created.
	locked: boolean
	onBuy: (method: PaymentMethod) => void
}

// A deep-linked plan scrolls into view once, when its card mounts.
function scrollIntoViewOnMount(node: HTMLDivElement | null): void {
	node?.scrollIntoView({ block: "center" })
}

function PlanCard({ card, showTerm, current, highlighted, purchase, buyDisabledReason, locked, onBuy }: PlanCardProps) {
	const { t } = useTranslation("settings")
	const { plan, price, discountPercent, limited, methods } = card
	const title = showTerm ? t("settingsBillingPlanNameWithTerm", { name: plan.name, term: t(TERM_KEYS[plan.term]) }) : plan.name

	return (
		<Card
			ref={highlighted ? scrollIntoViewOnMount : undefined}
			aria-current={highlighted ? "true" : undefined}
			className={cn("min-w-0", highlighted && "ring-2 ring-primary")}
		>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{t("settingsBillingPlanStorage", { storage: formatBytes(plan.storage) })}</CardDescription>
				<div className="flex flex-wrap gap-1.5">
					{current ? <Badge>{t("settingsBillingCurrentPlanBadge")}</Badge> : null}
					{plan.popular ? <Badge variant="secondary">{t("settingsBillingPopular")}</Badge> : null}
					{limited ? <Badge variant="outline">{t("settingsBillingLimited")}</Badge> : null}
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div>
					<div className="flex flex-wrap items-baseline gap-2">
						<span className="text-2xl font-semibold tabular-nums">{formatBillingCost(price)}</span>
						{discountPercent === undefined ? null : (
							<>
								<s className="text-sm text-muted-foreground tabular-nums">
									<span className="sr-only">
										{t("settingsBillingRegularPrice", { price: formatBillingCost(plan.cost) })}
									</span>
									<span aria-hidden="true">{formatBillingCost(plan.cost)}</span>
								</s>
								<Badge variant="destructive">{t("settingsBillingDiscount", { percent: discountPercent })}</Badge>
							</>
						)}
					</div>
					<p className="text-xs text-muted-foreground">{t(PERIOD_KEYS[plan.term])}</p>
				</div>
				<ul className="flex flex-col gap-1.5 text-sm">
					{FEATURE_KEYS.map(key => (
						<li
							key={key}
							className="flex items-center gap-2"
						>
							<CheckIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-primary"
							/>
							{t(key)}
						</li>
					))}
				</ul>
			</CardContent>
			<CardFooter className="mt-auto">
				{purchase.status === "ready" ? (
					<a
						href={purchase.url}
						target="_blank"
						rel="noopener noreferrer"
						className={cn(buttonVariants(), "w-full")}
						// The new subscription shows up on the next focus after paying, without polling.
						onClick={markAccountStale}
					>
						{t("settingsBillingPayInvoice")}
						<ArrowUpRightIcon
							aria-hidden="true"
							data-icon="inline-end"
						/>
					</a>
				) : (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									type="button"
									className="w-full"
									disabled={buyDisabledReason !== undefined || locked}
									title={buyDisabledReason}
								>
									{purchase.status === "pending" ? <Spinner data-icon="inline-start" /> : null}
									{t("settingsBillingBuy")}
									<ChevronDownIcon data-icon="inline-end" />
								</Button>
							}
						/>
						<DropdownMenuContent align="center">
							<DropdownMenuGroup>
								{methods.map(method => (
									<DropdownMenuItem
										key={method}
										onClick={() => {
											onBuy(method)
										}}
									>
										{t(METHOD_KEYS[method])}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</CardFooter>
		</Card>
	)
}

export { PlanCard }
