import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface NicknameCardProps {
	accountQuery: AccountQuerySuccess
}

// Inline edit + save (no dialog) — old-web/mobile both prompt for this in a modal, but a single
// optional string with no destructive consequence fits this card's own inline form better, matching
// this app's own idiom for a one-field save (see personalInfoCard.tsx). Save is disabled until the
// trimmed value actually differs from the server's current nickName. An empty trimmed value clears
// the nickname (`setNickname(null)`) — mirrors old-web's dialog (`allowEmptyValue`, 0..32 chars).
function NicknameCard({ accountQuery }: NicknameCardProps) {
	const { t } = useTranslation("settings")
	const isOnline = useIsOnline()
	const { nickName } = accountQuery.data
	const [value, setValue] = useState(nickName ?? "")
	const [pending, setPending] = useState(false)

	const trimmed = value.trim()
	const dirty = trimmed !== (nickName ?? "")

	async function handleSave(): Promise<void> {
		setPending(true)
		try {
			await sdkApi.setNickname(trimmed.length > 0 ? trimmed : null)
			toast.success(t("settingsNicknameSuccess"))
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
				<CardTitle>{t("settingsNicknameTitle")}</CardTitle>
				<CardDescription>{t("settingsNicknameDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				<Field orientation="responsive">
					<FieldLabel
						htmlFor="nickname-input"
						className="sr-only"
					>
						{t("settingsNicknameTitle")}
					</FieldLabel>
					<div className="flex w-full gap-2">
						<Input
							id="nickname-input"
							value={value}
							maxLength={32}
							placeholder={t("settingsNicknamePlaceholder")}
							disabled={pending}
							onChange={e => {
								setValue(e.target.value)
							}}
						/>
						<Button
							type="button"
							variant="outline"
							disabled={!dirty || pending || !isOnline}
							onClick={() => {
								void handleSave()
							}}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{t("settingsNicknameSave")}
						</Button>
					</div>
				</Field>
			</CardContent>
		</Card>
	)
}

export { NicknameCard }
