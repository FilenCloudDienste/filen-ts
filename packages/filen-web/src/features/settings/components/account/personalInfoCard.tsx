import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { SettingsKey } from "@/lib/i18n"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import {
	personalToFormState,
	formStateToUpdateInfo,
	isPersonalFormDirty,
	PERSONAL_FIELD_ORDER,
	type PersonalFormState
} from "@/features/settings/components/account/personalInfoCard.logic"
import { COUNTRIES } from "@/features/settings/lib/countries"
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface PersonalInfoCardProps {
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

// Collapsible (no Collapsible primitive in the registry — a plain local toggle over CardContent's
// presence, same "extend with existing primitives, never add to the locked registry" rule every
// other feature card here follows), collapsed by default: billing/invoice-style fields nobody fills
// in on day one. Form state is FROZEN at mount from the account query's `personal` snapshot (the
// same editor invariant this app's other freeze-on-mount forms use) — a background refetch from
// another card's save (avatar/nickname/email) must never clobber in-progress edits here. `initial`
// captures that SAME frozen snapshot a second time (P15's dirty-gate baseline) and is advanced to
// the just-saved `form` on a successful save — never re-derived from a refetch, which would violate
// the freeze invariant above.
function PersonalInfoCard({ accountQuery }: PersonalInfoCardProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const [expanded, setExpanded] = useState(false)
	const [initial, setInitial] = useState<PersonalFormState>(() => personalToFormState(accountQuery.data.personal))
	const [form, setForm] = useState<PersonalFormState>(initial)
	const [pending, setPending] = useState(false)
	const dirty = isPersonalFormDirty(form, initial)

	async function handleSave(): Promise<void> {
		setPending(true)
		try {
			await sdkApi.updatePersonalInfo(formStateToUpdateInfo(form))
			toast.success(t("settingsPersonalSuccess"))
			setInitial(form)
			void accountQuery.refetch()
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setPending(false)
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsPersonalTitle")}</CardTitle>
				<CardDescription>{t("settingsPersonalDescription")}</CardDescription>
				<CardAction>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => {
							setExpanded(current => !current)
						}}
					>
						{expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
						{expanded ? t("settingsPersonalCollapse") : t("settingsPersonalExpand")}
					</Button>
				</CardAction>
			</CardHeader>
			{expanded && (
				<>
					<CardContent>
						<FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							{PERSONAL_FIELD_ORDER.map(key =>
								key === "country" ? (
									<Field key={key}>
										<FieldLabel htmlFor="personal-country">{t(FIELD_LABEL_KEYS[key])}</FieldLabel>
										<Select
											items={[
												{ value: "", label: t("settingsPersonalCountryUnset") },
												...COUNTRIES.map(country => ({ value: country, label: country }))
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
													{COUNTRIES.map(country => (
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
					</CardContent>
					<CardFooter>
						<Button
							type="button"
							disabled={!dirty || pending || !isOnline}
							title={!isOnline ? t("common:offlineActionDisabled") : undefined}
							onClick={() => {
								void handleSave()
							}}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{t("settingsPersonalSave")}
						</Button>
					</CardFooter>
				</>
			)}
		</Card>
	)
}

export { PersonalInfoCard }
