import { useRef, useState, type ChangeEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/utils"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { validateAvatarFile, AVATAR_MAX_BYTES } from "@/features/settings/components/account/avatarCard.logic"
import { contactInitials } from "@/features/contacts/components/contactsList.logic"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface AvatarCardProps {
	accountQuery: AccountQuerySuccess
}

// Hidden file input triggered by the visible button — same "real input, styled trigger button"
// shape old-web's account avatar picker uses (its `#avatar-input` + label click), reset to "" in
// `finally` so re-picking the SAME file still fires a change event. Size/type constraints mirror
// that same old-web precedent (avatarCard.logic.ts) rather than mobile's native transcode pipeline,
// which has no browser equivalent this wave needs.
function AvatarCard({ accountQuery }: AvatarCardProps) {
	const { t } = useTranslation("settings")
	const { avatarUrl, nickName, email } = accountQuery.data
	const inputRef = useRef<HTMLInputElement>(null)
	const [pending, setPending] = useState(false)

	async function handleFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
		const file = e.target.files?.[0]

		try {
			if (!file) {
				return
			}

			const validation = validateAvatarFile(file)
			if (validation.status === "invalidType") {
				toast.error(t("settingsAvatarInvalidType"))
				return
			}
			if (validation.status === "tooLarge") {
				toast.error(t("settingsAvatarTooLarge", { max: formatBytes(AVATAR_MAX_BYTES) }))
				return
			}

			setPending(true)
			const buffer = new Uint8Array(await file.arrayBuffer())
			await sdkApi.uploadAvatar(buffer)
			toast.success(t("settingsAvatarUploadSuccess"))
			void accountQuery.refetch()
		} catch (err) {
			toast.error(errorLabel(asErrorDTO(err)))
		} finally {
			setPending(false)
			e.target.value = ""
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsAvatarTitle")}</CardTitle>
				<CardDescription>{t("settingsAvatarDescription")}</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-4">
					<Avatar
						size="lg"
						className="size-16"
					>
						{avatarUrl !== undefined ? <AvatarImage src={avatarUrl} /> : null}
						<AvatarFallback className="text-lg">{contactInitials(nickName ?? email)}</AvatarFallback>
					</Avatar>
					<Button
						type="button"
						variant="outline"
						disabled={pending}
						onClick={() => {
							inputRef.current?.click()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("settingsAvatarChangeAction")}
					</Button>
					<input
						ref={inputRef}
						type="file"
						accept="image/png,image/jpeg"
						className="hidden"
						disabled={pending}
						onChange={e => {
							void handleFileChange(e)
						}}
					/>
				</div>
			</CardContent>
		</Card>
	)
}

export { AvatarCard }
