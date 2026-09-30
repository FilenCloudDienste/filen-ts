import { useLayoutEffect, useRef } from "react"
import type { ChatParticipant } from "@filen/sdk-rs"
import { cn, contactDisplayName } from "@filen/shared"
import { safeAvatarUrl } from "@/lib/avatarUrl"
import type { EmojiSuggestion } from "@/features/chats/lib/emoji"
import { UserAvatar } from "@/components/userAvatar"
import { SURFACE_RING } from "@/components/ui/surface"
import { suggestionOptionId } from "@/features/chats/components/thread/composerSuggestions.logic"

export type ComposerSuggestionList =
	{ kind: "mention"; items: readonly ChatParticipant[] } | { kind: "emoji"; items: readonly EmojiSuggestion[] }

const OPTION_CLASS = "flex w-full cursor-default items-center gap-2.5 rounded-xl px-2 py-1.5 text-left"

// The textarea keeps focus and drives the list through aria-activedescendant, so rows are never focusable and
// select on mousedown (which fires before the textarea's blur).
export function ComposerSuggestions({
	listboxId,
	list,
	activeIndex,
	onSelectMention,
	onSelectEmoji
}: {
	listboxId: string
	list: ComposerSuggestionList
	activeIndex: number
	onSelectMention: (participant: ChatParticipant) => void
	onSelectEmoji: (suggestion: EmojiSuggestion) => void
}) {
	const listboxRef = useRef<HTMLDivElement | null>(null)

	// Keyboard navigation can move the active row past the capped height. The positioned listbox is its rows'
	// offsetParent, so their offsets are in its scroll space.
	useLayoutEffect(() => {
		const listbox = listboxRef.current
		const option = listbox?.children[activeIndex]

		if (listbox === null || !(option instanceof HTMLElement)) {
			return
		}

		if (option.offsetTop < listbox.scrollTop) {
			listbox.scrollTop = option.offsetTop
		} else if (option.offsetTop + option.offsetHeight > listbox.scrollTop + listbox.clientHeight) {
			listbox.scrollTop = option.offsetTop + option.offsetHeight - listbox.clientHeight
		}
	}, [activeIndex])

	return (
		<div
			ref={listboxRef}
			id={listboxId}
			role="listbox"
			className={cn(
				"absolute bottom-full left-0 z-10 mb-2 max-h-64 w-72 max-w-full overflow-y-auto rounded-2xl bg-popover p-1 shadow-lg",
				SURFACE_RING
			)}
		>
			{list.kind === "mention"
				? list.items.map((participant, index) => {
						const name = contactDisplayName(participant)

						return (
							<div
								key={participant.userId.toString()}
								id={suggestionOptionId(listboxId, index)}
								role="option"
								aria-selected={index === activeIndex}
								tabIndex={-1}
								className={cn(OPTION_CLASS, index === activeIndex ? "bg-accent" : "hover:bg-accent/50")}
								onMouseDown={event => {
									event.preventDefault()
									onSelectMention(participant)
								}}
							>
								<UserAvatar
									src={safeAvatarUrl(participant.avatar)}
									name={name}
									className="size-7 shrink-0"
								/>
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-sm">{name}</span>
									<span className="truncate text-xs text-muted-foreground">{participant.email}</span>
								</span>
							</div>
						)
					})
				: list.items.map((suggestion, index) => (
						<div
							key={`${suggestion.kind}-${suggestion.name}`}
							id={suggestionOptionId(listboxId, index)}
							role="option"
							aria-selected={index === activeIndex}
							tabIndex={-1}
							className={cn(OPTION_CLASS, index === activeIndex ? "bg-accent" : "hover:bg-accent/50")}
							onMouseDown={event => {
								event.preventDefault()
								onSelectEmoji(suggestion)
							}}
						>
							{suggestion.kind === "custom" ? (
								<img
									src={suggestion.imageUrl}
									alt=""
									loading="lazy"
									// require-corp COEP needs a CORS-mode request for a cross-origin image (the CDN
									// sends Access-Control-Allow-Origin: * but no Cross-Origin-Resource-Policy) —
									// see messageContent.tsx's matching comment for the verified detail.
									crossOrigin="anonymous"
									className="size-7 shrink-0 object-contain"
								/>
							) : (
								<span
									aria-hidden="true"
									className="w-7 shrink-0 text-center text-lg"
								>
									{suggestion.char}
								</span>
							)}
							<span className="truncate text-sm text-muted-foreground">:{suggestion.name}:</span>
						</div>
					))}
		</div>
	)
}
