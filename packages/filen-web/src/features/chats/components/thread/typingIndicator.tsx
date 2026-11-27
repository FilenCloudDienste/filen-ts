import type { BlockedUsers } from "@filen/shared"
import { useChatTypingLabel } from "@/features/chats/hooks/useChatTyping"

// The thread's typing line — a strip of fixed height between the message list and the composer, empty while nobody
// types, so its coming and going never moves the list. Three dots in the avatar gutter and the label in the text
// column. The live region stays mounted while nobody
// types, so the label is announced when it appears; the label is the shared typingText derivation, so its
// copy matches the sidebar-row preview override exactly.
export function TypingIndicator({
	chatUuid,
	currentUserId,
	blocked
}: {
	chatUuid: string
	currentUserId: bigint | undefined
	blocked: BlockedUsers
}) {
	const label = useChatTypingLabel(chatUuid, currentUserId, blocked)

	return (
		<div
			aria-live="polite"
			className="h-5 shrink-0 px-4"
		>
			{label !== null ? (
				<div className="flex items-center gap-4">
					<div
						aria-hidden="true"
						className="flex w-10 shrink-0 items-center justify-end gap-0.5"
					>
						<span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce motion-safe:[animation-delay:-0.3s]" />
						<span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce motion-safe:[animation-delay:-0.15s]" />
						<span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce" />
					</div>
					<span className="max-w-[760px] min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground">{label}</span>
				</div>
			) : null}
		</div>
	)
}
