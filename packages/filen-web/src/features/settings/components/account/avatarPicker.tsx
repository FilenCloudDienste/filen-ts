import { useRef, useState, type ChangeEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CameraIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { validateAvatarFile, AVATAR_MAX_BYTES } from "@/features/settings/components/account/avatarCard.logic"
import { contactInitials } from "@/features/contacts/components/contactsList.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Spinner } from "@/components/ui/spinner"

interface AvatarPickerProps {
	accountQuery: AccountQuerySuccess
}

// The avatar is its own "change picture" button over a hidden file input — same "real input, styled
// trigger" shape old-web's account avatar picker uses (its `#avatar-input` + label click), reset to ""
// in `finally` so re-picking the SAME file still fires a change event. Size/type constraints mirror
// that same old-web precedent (avatarCard.logic.ts) rather than mobile's native transcode pipeline,
// which has no browser equivalent this codebase needs.
function AvatarPicker({ accountQuery }: AvatarPickerProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const { avatarUrl, nickName, email } = accountQuery.data
	const inputRef = useRef<HTMLInputElement>(null)
	const [pending, setPending] = useState(false)
	const disabled = pending || !isOnline

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
		<div className="relative shrink-0">
			<button
				type="button"
				aria-label={t("settingsAvatarChangeAction")}
				disabled={disabled}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				className="group/avatar-picker relative block rounded-full focus-ring outline-none disabled:cursor-not-allowed"
				onClick={() => {
					inputRef.current?.click()
				}}
			>
				<Avatar
					size="lg"
					className="size-14"
				>
					{/* crossOrigin: require-corp COEP needs a CORS-mode request for this cross-origin egest
					    url — a plain no-cors <img> would need a Cross-Origin-Resource-Policy response header
					    the CDN doesn't send (verified live against the sibling cdn.filen.io emoji host, which
					    shares the same Access-Control-Allow-Origin: * pattern). */}
					{avatarUrl !== undefined ? (
						<AvatarImage
							src={avatarUrl}
							crossOrigin="anonymous"
						/>
					) : null}
					<AvatarFallback className="text-lg">{contactInitials(nickName ?? email)}</AvatarFallback>
				</Avatar>
				{pending ? (
					<span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/60">
						<Spinner />
					</span>
				) : (
					<span
						aria-hidden="true"
						className="absolute -right-0.5 -bottom-0.5 flex size-6 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-foreground/10 transition-colors group-hover/avatar-picker:text-foreground group-disabled/avatar-picker:opacity-50"
					>
						<CameraIcon className="size-3.5" />
					</span>
				)}
			</button>
			<input
				ref={inputRef}
				type="file"
				accept="image/png,image/jpeg"
				className="hidden"
				disabled={disabled}
				onChange={e => {
					void handleFileChange(e)
				}}
			/>
		</div>
	)
}

export { AvatarPicker }
