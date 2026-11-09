import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { isValidNickname } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { accountQueryUpdate, type AccountQuerySuccess } from "@/queries/account"
import { Input } from "@/components/ui/input"
import { FieldError } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface NicknameRowProps {
	accountQuery: AccountQuerySuccess
}

// Inline edit + save (no dialog) — old-web/mobile both prompt for this in a modal, but a single
// optional string with no destructive consequence fits an inline row better. Save is disabled until
// the trimmed value actually differs from the server's current nickName. An empty trimmed value clears
// the nickname (`setNickname(null)`). Anything else must pass the server's rule (isValidNickname); the
// error shows only once the value was edited, since a stored nickname may predate that rule.
function NicknameRow({ accountQuery }: NicknameRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const { nickName } = accountQuery.data
	const [value, setValue] = useState(nickName ?? "")
	const [pending, setPending] = useState(false)

	const trimmed = value.trim()
	const dirty = trimmed !== (nickName ?? "")
	const invalid = dirty && !isValidNickname(trimmed)

	async function handleSave(): Promise<void> {
		if (!dirty || invalid || !isOnline) {
			return
		}

		const next = trimmed.length > 0 ? trimmed : null

		setPending(true)

		const outcome = await sdkApi.setNickname(next).then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err })
		)

		setPending(false)

		if (!outcome.ok) {
			toast.error(errorLabel(outcome.err))

			return
		}

		toast.success(t("settingsNicknameSuccess"))
		accountQueryUpdate(prev => ({ ...prev, nickName: next ?? undefined }))
	}

	return (
		<SettingsRow
			label={t("settingsNicknameTitle")}
			description={t("settingsNicknameDescription")}
			htmlFor="nickname-input"
		>
			<Input
				id="nickname-input"
				className="min-w-0 flex-1 sm:w-48 sm:flex-none"
				value={value}
				maxLength={32}
				placeholder={t("settingsNicknamePlaceholder")}
				aria-invalid={invalid}
				aria-describedby={invalid ? "nickname-input-error" : undefined}
				disabled={pending}
				onChange={e => {
					setValue(e.target.value)
				}}
			/>
			<Button
				type="button"
				variant="outline"
				disabled={!dirty || invalid || pending || !isOnline}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onClick={() => {
					void handleSave()
				}}
			>
				{pending && <Spinner data-icon="inline-start" />}
				{t("settingsNicknameSave")}
			</Button>
			{invalid && (
				<FieldError
					id="nickname-input-error"
					className="basis-full"
				>
					{t("settingsNicknameInvalidError")}
				</FieldError>
			)}
		</SettingsRow>
	)
}

export { NicknameRow }
