import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { UserAccountSubs, UserInfo } from "@filen/sdk-rs"
import { isValidEmail } from "@filen/shared"
import {
	eligibleWithdrawals,
	formatBillingCost,
	toMillis,
	withdrawalLanguage,
	withdrawalNamePrefill,
	WITHDRAWAL_NAME_MAX_LENGTH
} from "@/features/settings/lib/billing"
import { billingErrorLabel, withdrawSubscription } from "@/features/settings/lib/billingActions"
import { formatShortDate } from "@/lib/formatDate"
import { useIsOnline } from "@/lib/useIsOnline"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface WithdrawalDialogProps {
	open: boolean
	account: UserInfo
	// Eligibility is judged at this moment (the host's billing clock).
	now: number
	// Preselected contract; else the one whose window closes first.
	subId?: string | undefined
	onOpenChange: (open: boolean) => void
}

interface WithdrawalForm {
	name: string
	email: string
	subId: string
}

function seedForm(account: UserInfo, contracts: readonly UserAccountSubs[], subId: string | undefined): WithdrawalForm {
	const preselected = contracts.find(sub => sub.id === subId) ?? contracts[0]

	return { name: withdrawalNamePrefill(account), email: account.email, subId: preselected?.id ?? "" }
}

function contractDetail(sub: UserAccountSubs): { date: string; id: string } {
	const start = toMillis(sub.startTimestamp)

	return { date: start === undefined ? "" : formatShortDate(start), id: sub.id.slice(0, 8) }
}

// One step, by design: the confirm button is the declaration. Name and email are prefilled; the contract chooser
// appears only when more than one contract is open to withdrawal. The form is seeded on each open.
function WithdrawalDialog({ open, account, now, subId, onOpenChange }: WithdrawalDialogProps) {
	const { t, i18n } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const eligible = eligibleWithdrawals(account.subs, now)
	const [wasOpen, setWasOpen] = useState(open)
	// Taken at open, so the received withdrawal (patched into the account) does not empty the dialog as it closes.
	const [contracts, setContracts] = useState(eligible)
	const [form, setForm] = useState<WithdrawalForm>(() => seedForm(account, eligible, subId))
	const [showErrors, setShowErrors] = useState(false)
	const [pending, setPending] = useState(false)

	if (open !== wasOpen) {
		setWasOpen(open)

		if (open) {
			setContracts(eligible)
			setForm(seedForm(account, eligible, subId))
			setShowErrors(false)
		}
	}

	const name = form.name.trim()
	const email = form.email.trim()
	const nameInvalid = name === "" || name.length > WITHDRAWAL_NAME_MAX_LENGTH
	const emailInvalid = !isValidEmail(email)
	const contract = contracts.find(sub => sub.id === form.subId)
	const detail = contract === undefined ? undefined : contractDetail(contract)

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()

		if (nameInvalid || emailInvalid) {
			setShowErrors(true)

			return
		}

		if (contract === undefined) {
			return
		}

		setPending(true)

		const outcome = await withdrawSubscription({ subId: contract.id, name, email, lang: withdrawalLanguage(i18n.language) })

		setPending(false)

		if (outcome.status === "error") {
			toast.error(billingErrorLabel(outcome.dto))

			return
		}

		if (outcome.status === "unconfirmed") {
			toast.warning(t("settingsBillingWithdrawReceiptMissing"))
		} else {
			toast.success(t("settingsBillingWithdrawSuccess"))
		}

		onOpenChange(false)
	}

	return (
		<FormDialog
			open={open}
			pending={pending}
			title={t("settingsBillingWithdraw")}
			description={t("settingsBillingWithdrawDescription")}
			submitLabel={t("settingsBillingWithdrawConfirm")}
			cancelLabel={t("common:cancel")}
			canSubmit={isOnline && contract !== undefined}
			submitTitle={!isOnline ? t("common:offlineActionDisabled") : undefined}
			onOpenChange={onOpenChange}
			onSubmit={e => {
				void handleSubmit(e)
			}}
		>
			{contracts.length === 0 ? (
				<p
					role="status"
					className="text-sm text-muted-foreground"
				>
					{t("settingsBillingWithdrawNoneEligible")}
				</p>
			) : (
				<FieldGroup>
					<Field data-invalid={showErrors && nameInvalid ? true : undefined}>
						<FieldLabel htmlFor="withdrawal-name">{t("settingsBillingWithdrawName")}</FieldLabel>
						<Input
							id="withdrawal-name"
							autoComplete="name"
							maxLength={WITHDRAWAL_NAME_MAX_LENGTH}
							value={form.name}
							disabled={pending}
							aria-invalid={showErrors && nameInvalid}
							aria-describedby={showErrors && nameInvalid ? "withdrawal-name-error" : undefined}
							onChange={e => {
								const next = e.target.value

								setForm(current => ({ ...current, name: next }))
							}}
						/>
						{showErrors && nameInvalid ? (
							<FieldError id="withdrawal-name-error">{t("settingsBillingWithdrawNameRequired")}</FieldError>
						) : null}
					</Field>
					<Field>
						<FieldLabel htmlFor="withdrawal-contract">{t("settingsBillingWithdrawContract")}</FieldLabel>
						{contracts.length > 1 ? (
							<Select
								items={contracts.map(sub => ({
									value: sub.id,
									label: t("settingsBillingWithdrawContractLabel", {
										plan: sub.planName,
										cost: formatBillingCost(sub.planCost)
									})
								}))}
								value={form.subId}
								disabled={pending}
								onValueChange={value => {
									if (value !== null) {
										setForm(current => ({ ...current, subId: value }))
									}
								}}
							>
								<SelectTrigger
									id="withdrawal-contract"
									className="w-full"
									aria-describedby="withdrawal-contract-detail"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{contracts.map(sub => (
											<SelectItem
												key={sub.id}
												value={sub.id}
											>
												{t("settingsBillingWithdrawContractLabel", {
													plan: sub.planName,
													cost: formatBillingCost(sub.planCost)
												})}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						) : (
							<Input
								id="withdrawal-contract"
								readOnly
								aria-describedby="withdrawal-contract-detail"
								value={
									contract === undefined
										? ""
										: t("settingsBillingWithdrawContractLabel", {
												plan: contract.planName,
												cost: formatBillingCost(contract.planCost)
											})
								}
							/>
						)}
						{detail === undefined ? null : (
							<FieldDescription id="withdrawal-contract-detail">
								{t("settingsBillingWithdrawContractDetail", detail)}
							</FieldDescription>
						)}
					</Field>
					<Field data-invalid={showErrors && emailInvalid ? true : undefined}>
						<FieldLabel htmlFor="withdrawal-email">{t("settingsBillingWithdrawEmail")}</FieldLabel>
						<Input
							id="withdrawal-email"
							// Not type="email": the browser's own check would block the submit before the inline error shows.
							inputMode="email"
							autoComplete="email"
							value={form.email}
							disabled={pending}
							aria-invalid={showErrors && emailInvalid}
							aria-describedby={showErrors && emailInvalid ? "withdrawal-email-error" : undefined}
							onChange={e => {
								const next = e.target.value

								setForm(current => ({ ...current, email: next }))
							}}
						/>
						{showErrors && emailInvalid ? (
							<FieldError id="withdrawal-email-error">{t("settingsBillingWithdrawEmailInvalid")}</FieldError>
						) : null}
					</Field>
				</FieldGroup>
			)}
		</FormDialog>
	)
}

export { WithdrawalDialog }
