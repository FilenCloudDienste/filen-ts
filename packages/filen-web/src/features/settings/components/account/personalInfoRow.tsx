import { useState, type SubmitEvent } from "react"
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

// Billing/invoice-style fields nobody fills in on day one, so they live behind an Edit dialog. Form
// state is FROZEN at mount from the account query's `personal` snapshot (the same editor invariant this
// app's other freeze-on-mount forms use) — a background refetch from another row's save
// (avatar/nickname/email) must never clobber in-progress edits here. `initial` captures that SAME
// frozen snapshot a second time (the dirty-gate's baseline) and is advanced to the just-saved, trimmed
// values on a successful save (a blank field is cleared on the server) — never re-derived from a refetch,
// which would violate the freeze invariant above. Dismissing the dialog puts the form back to
// `initial`, so an abandoned edit never reappears as if it were saved.
function PersonalInfoRow({ accountQuery }: PersonalInfoRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)
	const [initial, setInitial] = useState<PersonalFormState>(() => personalToFormState(accountQuery.data.personal))
	const [form, setForm] = useState<PersonalFormState>(initial)
	const [pending, setPending] = useState(false)
	const dirty = isPersonalFormDirty(form, initial)
	const issue = personalFormIssue(form)
	const canSubmit = dirty && issue === null && isOnline
	const countries = countryOptions(form.country)

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
		const saved = personalToFormState(personal)

		setInitial(saved)
		setForm(saved)
		setOpen(false)
		accountQueryUpdate(prev => ({ ...prev, personal: mergePersonalUpdate(prev.personal, sent) }))

		// The server stores its own normalized form of a VAT ID; the next background read picks it up.
		if (sent.vatId !== undefined) {
			markAccountStale()
		}
	}

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
						setOpen(false)
						setForm(initial)
					}
				}}
				onSubmit={e => {
					void handleSubmit(e)
				}}
			>
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
										aria-invalid={issue !== null}
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
		</SettingsRow>
	)
}

export { PersonalInfoRow }
