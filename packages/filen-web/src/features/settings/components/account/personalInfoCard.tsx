import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { SettingsKey } from "@/lib/i18n"
import type { AccountQuerySuccess } from "@/queries/account"
import {
	personalToFormState,
	formStateToUpdateInfo,
	PERSONAL_FIELD_ORDER,
	type PersonalFormState
} from "@/features/settings/components/account/personalInfoCard.logic"
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

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
// another card's save (avatar/nickname/email) must never clobber in-progress edits here. Country is
// a plain text field: no country-list dependency exists in this package yet (mobile's exported
// `countries[]` has no web equivalent), so this stays a simplification rather than inventing one.
function PersonalInfoCard({ accountQuery }: PersonalInfoCardProps) {
	const { t } = useTranslation("settings")
	const [expanded, setExpanded] = useState(false)
	const [form, setForm] = useState<PersonalFormState>(() => personalToFormState(accountQuery.data.personal))
	const [pending, setPending] = useState(false)

	async function handleSave(): Promise<void> {
		setPending(true)
		try {
			await sdkApi.updatePersonalInfo(formStateToUpdateInfo(form))
			toast.success(t("settingsPersonalSuccess"))
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
							{PERSONAL_FIELD_ORDER.map(key => (
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
							))}
						</FieldGroup>
					</CardContent>
					<CardFooter>
						<Button
							type="button"
							disabled={pending}
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
