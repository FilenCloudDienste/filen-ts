import { useChatTyping, useChatTypingLabel } from "@/features/chats/hooks/useChatTyping"
import { typingUserName } from "@/features/chats/lib/typing"
import { BubbleTail, OTHER_TAIL_CLASS } from "@/features/chats/components/thread/messageRow"

// The thread's typing bubble — at the bottom of the scroller, outside the virtualized rows, so it never
// moves a row's position (messageThread.tsx keeps a scrolled-up reader's view still as it comes and goes).
// Styled as someone else's bubble holding three dots, named above in a group chat. The live region stays
// mounted while nobody types, so the label is announced when it appears; the label is the shared
// typingText derivation, so its copy matches the sidebar-row preview override exactly.
export function TypingIndicator({
	chatUuid,
	currentUserId,
	group
}: {
	chatUuid: string
	currentUserId: bigint | undefined
	group: boolean
}) {
	const label = useChatTypingLabel(chatUuid, currentUserId)
	const users = useChatTyping(chatUuid, currentUserId)

	return (
		<div
			aria-live="polite"
			className="px-4"
		>
			{label !== null ? (
				<div className="flex items-end gap-2 pt-2.5">
					<span className="sr-only">{label}</span>
					{group ? <div className="w-7 shrink-0" /> : null}
					<div
						aria-hidden="true"
						className="flex min-w-0 flex-col items-start"
					>
						{group ? (
							<span className="max-w-full truncate px-3 pb-0.5 text-xs text-muted-foreground">
								{users.map(typingUserName).join(", ")}
							</span>
						) : null}
						<div className="relative flex h-8 items-center gap-1 rounded-[18px] rounded-bl-[6px] bg-chat-other px-3.5">
							<span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce motion-safe:[animation-delay:-0.3s]" />
							<span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce motion-safe:[animation-delay:-0.15s]" />
							<span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce" />
							<BubbleTail className={`${OTHER_TAIL_CLASS} text-chat-other`} />
						</div>
					</div>
				</div>
			) : null}
		</div>
	)
}
