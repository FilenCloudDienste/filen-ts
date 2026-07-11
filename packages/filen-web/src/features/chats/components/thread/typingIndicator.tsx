import { useChatTypingLabel } from "@/features/chats/hooks/useChatTyping"

// The thread's typing footer — sits directly above the composer, dense-layout-consistent (a thin muted
// line). Renders nothing when no remote user is typing; the label is the shared typingText derivation so
// its copy matches the sidebar-row preview override exactly.
export function TypingIndicator({ chatUuid, currentUserId }: { chatUuid: string; currentUserId: bigint | undefined }) {
	const label = useChatTypingLabel(chatUuid, currentUserId)

	if (label === null) {
		return null
	}

	return (
		<div
			aria-live="polite"
			className="flex shrink-0 items-center gap-1.5 px-4 pt-1 text-xs text-muted-foreground"
		>
			<span className="flex gap-0.5">
				<span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
				<span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
				<span className="size-1 animate-bounce rounded-full bg-muted-foreground" />
			</span>
			<span className="truncate">{label}</span>
		</div>
	)
}
