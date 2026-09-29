import { useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { countryOptions } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { SettingsKey } from "@/lib/i18n"
import { useIsOnline } from "@/lib/useIsOnline"
import { accountQueryUpdate, type AccountQuerySuccess } from "@/queries/account"
import {
	personalToFormState,
	formStateToUpdateInfo,
	isPersonalFormDirty,
	keepBlankFields,
	mergePersonalUpdate,
	PERSONAL_FIELD_ORDER,
	type PersonalFormState
} from "@/features/settings/components/account/personalInfoCard.logic"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
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
// frozen snapshot a second time (the dirty-gate's baseline) and is advanced to the just-saved `form` on
// a successful save, its blank fields showing the values they kept — never re-derived from a refetch,
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
	const countries = countryOptions(form.country)

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()

		if (!dirty || !isOnline) {
			return
		}

		setPending(true)
		try {
			const sent = formStateToUpdateInfo(form)
			await sdkApi.updatePersonalInfo(sent)
			toast.success(t("settingsPersonalSuccess"))
			// A blank field is sent as "leave unchanged", so it shows, and stays cached, as the value it kept.
			const saved = keepBlankFields(form, accountQuery.data.personal)
			setInitial(saved)
			setForm(saved)
			setOpen(false)
			accountQueryUpdate(prev => ({ ...prev, personal: mergePersonalUpdate(prev.personal, sent) }))
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			setPending(false)
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
				canSubmit={dirty && isOnline}
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
