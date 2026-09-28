import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { accountQueryUpdate, type AccountQuerySuccess } from "@/queries/account"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface NicknameRowProps {
	accountQuery: AccountQuerySuccess
}

// Inline edit + save (no dialog) — old-web/mobile both prompt for this in a modal, but a single
// optional string with no destructive consequence fits an inline row better. Save is disabled until
// the trimmed value actually differs from the server's current nickName. An empty trimmed value clears
// the nickname (`setNickname(null)`) — mirrors old-web's dialog (`allowEmptyValue`, 0..32 chars).
function NicknameRow({ accountQuery }: NicknameRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const { nickName } = accountQuery.data
	const [value, setValue] = useState(nickName ?? "")
	const [pending, setPending] = useState(false)

	const trimmed = value.trim()
	const dirty = trimmed !== (nickName ?? "")

	async function handleSave(): Promise<void> {
		setPending(true)
		try {
			const next = trimmed.length > 0 ? trimmed : null
			await sdkApi.setNickname(next)
			toast.success(t("settingsNicknameSuccess"))
			accountQueryUpdate(prev => ({ ...prev, nickName: next ?? undefined }))
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setPending(false)
		}
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
				disabled={pending}
				onChange={e => {
					setValue(e.target.value)
				}}
			/>
			<Button
				type="button"
				variant="outline"
				disabled={!dirty || pending || !isOnline}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onClick={() => {
					void handleSave()
				}}
			>
				{pending && <Spinner data-icon="inline-start" />}
				{t("settingsNicknameSave")}
			</Button>
		</SettingsRow>
	)
}

export { NicknameRow }
