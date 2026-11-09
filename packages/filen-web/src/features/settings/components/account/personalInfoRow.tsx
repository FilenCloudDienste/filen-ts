import { useState, type SubmitEvent } from "react"
import type { Personal } from "@filen/sdk-rs"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { countryOptions } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { SettingsKey } from "@/lib/i18n"
import { useIsOnline } from "@/lib/useIsOnline"
import { accountQueryUpdate, markAccountStale, type AccountQuerySuccess } from "@/queries/account"
import {
	personalToFormState,
	formStateToUpdateInfo,
	isPersonalFormDirty,
	mergePersonalUpdate,
	personalFormIssue,
	PERSONAL_FIELD_ORDER,
	type PersonalFormState
} from "@/features/settings/components/account/personalInfoCard.logic"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { FormDialog } from "@/components/dialogs/formDialog"

interface PersonalInfoRowProps {
	accountQuery: AccountQuerySuccess
}

const FIELD_LABEL_KEYS: Record<keyof PersonalFormState, SettingsKey> = {
	firstName: "settingsPersonalFirstName",
	lastName: "settingsPersonalLastName",
	companyName: "settingsPersonalCompanyName",
	vatId: "settingsPersonalVatId",
	street: "settingsPersonalStreet",
	streetNumber: "settingsPersonalStreetNumber",
	city: "settingsPersonalCity",
	postalCode: "settingsPersonalPostalCode",
	country: "settingsPersonalCountry"
}

// Billing/invoice-style fields nobody fills in on day one, so they live behind an Edit dialog.
function PersonalInfoRow({ accountQuery }: PersonalInfoRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const [open, setOpen] = useState(false)

	return (
		<SettingsRow
			label={t("settingsPersonalTitle")}
			description={t("settingsPersonalDescription")}
		>
			<Button
				type="button"
				variant="outline"
				aria-label={t("settingsPersonalEditAction")}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("settingsRowEditAction")}
			</Button>
			<PersonalInfoDialog
				open={open}
				accountQuery={accountQuery}
				onOpenChange={setOpen}
			/>
		</SettingsRow>
	)
}

interface PersonalInfoDialogProps {
	open: boolean
	accountQuery: AccountQuerySuccess
	onOpenChange: (open: boolean) => void
	// Shown above the fields, e.g. why a purchase needs a country first.
	notice?: string | undefined
	// The save stays off until a country is chosen.
	requireCountry?: boolean | undefined
	// After a successful save, with the record as the server now holds it.
	onSaved?: ((personal: Personal) => void) | undefined
}

// The form is seeded from the cached account each time the dialog opens, never while it is open: a background
// refetch must not clobber edits in progress, and a host that stays mounted (the plans view) still opens on the
// current record. `initial` is that seed, the dirty gate's baseline.
function PersonalInfoDialog({ open, accountQuery, onOpenChange, notice, requireCountry, onSaved }: PersonalInfoDialogProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const [wasOpen, setWasOpen] = useState(open)
	const [initial, setInitial] = useState<PersonalFormState>(() => personalToFormState(accountQuery.data.personal))
	const [form, setForm] = useState<PersonalFormState>(initial)
	const [pending, setPending] = useState(false)

	if (open !== wasOpen) {
		setWasOpen(open)

		if (open) {
			const seed = personalToFormState(accountQuery.data.personal)

			setInitial(seed)
			setForm(seed)
		}
	}

	const countryMissing = requireCountry === true && form.country.trim() === ""
	const dirty = isPersonalFormDirty(form, initial)
	const issue = personalFormIssue(form)
	const canSubmit = dirty && issue === null && !countryMissing && isOnline
	const countries = countryOptions(form.country)
	const countryInvalid = issue !== null || countryMissing

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()

		if (!canSubmit) {
			return
		}

		const sent = formStateToUpdateInfo(form)

		setPending(true)

		const outcome = await sdkApi.updatePersonalInfo(sent).then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err })
		)

		setPending(false)

		if (!outcome.ok) {
			// The dialog stays open with the edits, e.g. when the VAT ID check service is down.
			toast.error(errorLabel(outcome.err))

			return
		}

		toast.success(t("settingsPersonalSuccess"))

		const personal = mergePersonalUpdate(accountQuery.data.personal, sent)

		onOpenChange(false)
		accountQueryUpdate(prev => ({ ...prev, personal: mergePersonalUpdate(prev.personal, sent) }))

		// The server stores its own normalized form of a VAT ID; the next background read picks it up.
		if (sent.vatId !== undefined) {
			markAccountStale()
		}

		onSaved?.(personal)
	}

	return (
		<FormDialog
			open={open}
			pending={pending}
			title={t("settingsPersonalTitle")}
			description={t("settingsPersonalDescription")}
			submitLabel={t("settingsPersonalSave")}
			cancelLabel={t("common:cancel")}
			canSubmit={canSubmit}
			submitTitle={!isOnline ? t("common:offlineActionDisabled") : undefined}
			wide
			onOpenChange={next => {
				if (!next) {
					onOpenChange(false)
				}
			}}
			onSubmit={e => {
				void handleSubmit(e)
			}}
		>
			{notice === undefined ? null : (
				<p
					role="status"
					className="mb-4 text-sm text-muted-foreground"
				>
					{notice}
				</p>
			)}
			<FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{PERSONAL_FIELD_ORDER.map(key =>
					key === "country" ? (
						<Field key={key}>
							<FieldLabel htmlFor="personal-country">{t(FIELD_LABEL_KEYS[key])}</FieldLabel>
							<Select
								items={[
									{ value: "", label: t("settingsPersonalCountryUnset") },
									...countries.map(country => ({ value: country, label: country }))
								]}
								value={form.country}
								disabled={pending}
								onValueChange={value => {
									if (value !== null) {
										setForm(current => ({ ...current, country: value }))
									}
								}}
							>
								<SelectTrigger
									id="personal-country"
									className="w-full"
									aria-invalid={countryInvalid}
									aria-describedby={issue !== null ? "personal-country-error" : undefined}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										<SelectItem value="">{t("settingsPersonalCountryUnset")}</SelectItem>
										{countries.map(country => (
											<SelectItem
												key={country}
												value={country}
											>
												{country}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							{issue !== null && (
								<FieldError id="personal-country-error">
									{t(
										issue === "countryOffList"
											? "settingsPersonalCountryOffListError"
											: "settingsPersonalVatIdNeedsCountryError"
									)}
								</FieldError>
							)}
						</Field>
					) : (
						<Field key={key}>
							<FieldLabel htmlFor={`personal-${key}`}>{t(FIELD_LABEL_KEYS[key])}</FieldLabel>
							<Input
								id={`personal-${key}`}
								value={form[key]}
								disabled={pending}
								onChange={e => {
									const nextValue = e.target.value
									setForm(current => ({ ...current, [key]: nextValue }))
								}}
							/>
						</Field>
					)
				)}
			</FieldGroup>
		</FormDialog>
	)
}

export { PersonalInfoRow, PersonalInfoDialog }
