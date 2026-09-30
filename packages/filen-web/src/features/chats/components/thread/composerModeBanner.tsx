import { useTranslation } from "react-i18next"
import { CornerUpLeftIcon, PencilIcon, XIcon } from "lucide-react"
import type { ChatMessage } from "@filen/sdk-rs"
import { cn } from "@filen/shared"
import { safeAvatarUrl } from "@/lib/avatarUrl"
import { messageSenderName } from "@/features/chats/lib/sort"
import { isOwnMessage } from "@/features/chats/lib/sender"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/userAvatar"
import { GLASS_SURFACE_CLASS } from "@/components/ui/surface"

// The reply / edit context card floating above the input pill.
export function ComposerModeBanner({
	kind,
	message,
	currentUserId,
	onCancel
}: {
	kind: "reply" | "edit"
	message: ChatMessage
	currentUserId: bigint | undefined
	onCancel: () => void
}) {
	const { t } = useTranslation("chats")

	return (
		<div className={cn("flex items-center gap-2.5 rounded-2xl py-1.5 pr-1.5 pl-3 text-sm", GLASS_SURFACE_CLASS)}>
			{kind === "reply" ? (
				<>
					<CornerUpLeftIcon
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<ReplyTarget
						message={message}
						currentUserId={currentUserId}
					/>
				</>
			) : (
				<>
					<PencilIcon
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate font-medium">{t("chatComposerEditing")}</span>
				</>
			)}
			<Button
				variant="ghost"
				size="icon-sm"
				className="shrink-0 rounded-full text-muted-foreground"
				aria-label={kind === "reply" ? t("chatComposerCancelReply") : t("chatComposerCancelEdit")}
				onClick={onCancel}
			>
				<XIcon />
			</Button>
		</div>
	)
}

function ReplyTarget({ message, currentUserId }: { message: ChatMessage; currentUserId: bigint | undefined }) {
	const { t } = useTranslation("chats")
	const name = messageSenderName(message)
	const snippet = message.message

	return (
		<>
			<UserAvatar
				src={safeAvatarUrl(message.senderAvatar)}
				name={name}
				size="sm"
				className="size-7 shrink-0"
			/>
			<span className="flex min-w-0 flex-1 flex-col leading-tight">
				<span className="truncate text-xs font-medium">
					{isOwnMessage(message, currentUserId) ? t("chatReplyingToSelf") : t("chatReplyingTo", { name })}
				</span>
				{snippet !== undefined && snippet.length > 0 ? <span className="truncate text-muted-foreground">{snippet}</span> : null}
			</span>
		</>
	)
}
