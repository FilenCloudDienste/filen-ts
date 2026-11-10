import type { ReactNode } from "react"
import { Trans, useTranslation } from "react-i18next"
import { formatBytes, cn } from "@filen/shared"
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon } from "lucide-react"
import type { SettingsKey } from "@/lib/i18n"
import { formatBillingCost } from "@/features/settings/lib/billing"
import { PRICE_SUFFIX_KEYS, type PaymentMethod, type PlanCard as PlanCardModel } from "@/features/settings/lib/plans"
import { markAccountStale } from "@/queries/account"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
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

const METHOD_KEYS: Record<PaymentMethod, SettingsKey> = {
	stripe: "settingsBillingMethodCard",
	paypal: "settingsBillingMethodPaypal",
	crypto: "settingsBillingMethodCrypto"
}

// The card's purchase state, owned by the plans view so one checkout runs at a time.
export type PlanPurchase = { status: "idle" } | { status: "pending" } | { status: "ready"; url: string }

interface PlanCardProps {
	card: PlanCardModel
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

// Trans puts the formatted size in as children.
function StorageFigure({ children }: { children?: ReactNode }) {
	return <span className="font-heading text-2xl font-semibold tracking-tight text-foreground tabular-nums">{children}</span>
}

function PlanCard({ card, current, highlighted, purchase, buyDisabledReason, locked, onBuy }: PlanCardProps) {
	const { t } = useTranslation("settings")
	const { plan, price, discountPercent, limited, methods, annualSavingsPercent } = card
	// Annual plans lead with what a month costs; the yearly charge follows in small print.
	const annual = plan.term === "annually"
	const shownPrice = annual ? price / 12 : price
	const shownRegular = annual ? plan.cost / 12 : plan.cost
	const popular = plan.popular

	return (
		<Card
			ref={highlighted ? scrollIntoViewOnMount : undefined}
			aria-current={highlighted ? "true" : undefined}
			className={cn(
				"min-w-0 transition-shadow duration-200 hover:shadow-md",
				popular && "shadow-md ring-2 ring-primary hover:shadow-lg",
				highlighted && "outline-2 outline-offset-4 outline-ring"
			)}
		>
			<CardHeader className="gap-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className="min-w-0 font-heading text-base font-medium break-words">{plan.name}</h2>
					{popular || limited ? (
						<div className="flex flex-wrap gap-1.5">
							{popular ? <Badge>{t("settingsBillingPopular")}</Badge> : null}
							{limited ? <Badge variant="outline">{t("settingsBillingLimited")}</Badge> : null}
						</div>
					) : null}
				</div>
				<div className="flex flex-col gap-1">
					<p className="flex flex-wrap items-baseline gap-x-1.5">
						<span className="font-heading text-4xl font-semibold tracking-tight tabular-nums">
							{formatBillingCost(shownPrice)}
						</span>
						<span className="text-sm text-muted-foreground">
							{t(annual ? PRICE_SUFFIX_KEYS.monthly : PRICE_SUFFIX_KEYS[plan.term])}
						</span>
					</p>
					{discountPercent === undefined ? null : (
						<div className="flex flex-wrap items-center gap-2">
							<s className="text-sm text-muted-foreground tabular-nums">
								<span className="sr-only">
									{t("settingsBillingRegularPrice", { price: formatBillingCost(shownRegular) })}
								</span>
								<span aria-hidden="true">{formatBillingCost(shownRegular)}</span>
							</s>
							<Badge variant="destructive">{t("settingsBillingDiscount", { percent: discountPercent })}</Badge>
						</div>
					)}
					{annual ? (
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
							<span>{t("settingsBillingBilledYearly", { price: formatBillingCost(price) })}</span>
							{annualSavingsPercent === undefined ? null : (
								<Badge variant="secondary">{t("settingsBillingSavePercent", { percent: annualSavingsPercent })}</Badge>
							)}
						</div>
					) : null}
				</div>
				<p className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-muted-foreground">
					<Trans
						t={t}
						i18nKey="settingsBillingPlanStorage"
						values={{ storage: formatBytes(plan.storage) }}
						components={{ size: <StorageFigure /> }}
					/>
				</p>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<Separator />
				<ul className="flex flex-col gap-2 text-sm">
					{FEATURE_KEYS.map(key => (
						<li
							key={key}
							className="flex items-start gap-2.5"
						>
							<span
								aria-hidden="true"
								className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
							>
								<CheckIcon className="size-3" />
							</span>
							{t(key)}
						</li>
					))}
				</ul>
			</CardContent>
			<CardFooter className="mt-auto">
				{current ? (
					<Button
						type="button"
						variant="secondary"
						className="w-full"
						disabled
					>
						<CheckIcon
							aria-hidden="true"
							data-icon="inline-start"
						/>
						{t("settingsBillingCurrentPlanBadge")}
					</Button>
				) : purchase.status === "ready" ? (
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
									variant={popular ? "default" : "outline"}
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
