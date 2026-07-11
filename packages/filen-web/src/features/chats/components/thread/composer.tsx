import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ArrowUpIcon, XIcon, CornerUpLeftIcon, PencilIcon } from "lucide-react"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { enqueueChatMessage } from "@/features/chats/lib/sync"
import { editMessage } from "@/features/chats/lib/messageActions"
import type { OptimisticSender } from "@/features/chats/lib/sync.logic"
import {
	MAX_CHAT_MESSAGE_LENGTH,
	canSend,
	isOverLimit,
	remainingChars,
	shouldShowCounter,
	enterIntent,
	shouldEditLastOnArrowUp,
	buildReplyPartial,
	activeMentionQuery,
	activeEmojiQuery,
	filterMentionParticipants,
	filterEmojiSuggestions,
	applyMention,
	applyEmoji,
	lastEditableOwnMessage,
	NEW_MODE,
	type TriggerQuery
} from "@/features/chats/lib/composer.logic"
import { contactDisplayName, contactInitials } from "@/features/contacts/components/contactsList.logic"
import type { EmojiSuggestion } from "@/features/chats/lib/emoji"
import { useChatComposerEntry, useChatComposerStore } from "@/features/chats/store/useChatComposer"
import { loadDraft, saveDraftDebounced } from "@/features/chats/lib/drafts"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

// Grow the input with its content up to this many px, then scroll internally (mobile caps at a quarter
// screen; a fixed desktop cap reads cleaner).
const MAX_TEXTAREA_HEIGHT = 200
// Autocomplete popovers cap at this many rows (mobile caps emoji at 10).
const MENTION_LIMIT = 12
const EMOJI_LIMIT = 8

function senderName(message: ChatMessage): string {
	return message.senderNickName !== undefined && message.senderNickName.length > 0 ? message.senderNickName : message.senderEmail
}

// The composer — replaces C1's disabled strip. EVERY send goes through the C3 outbox (enqueueChatMessage),
// never sdkApi.sendChatMessage directly, so a send survives a window close / lost connection. Edits are
// the one exception: online-best-effort (editMessage), NOT outbox-queued, mirroring mobile/old-web. The
// send button is disabled only on an empty / over-limit body — NEVER offline (an offline send queues, the
// whole point). Draft/reply/edit live in the per-chat composer store (survive navigation); the draft also
// mirrors to disk for cross-reload durability.
export function Composer({
	chat,
	messages,
	nonConfirmedUuids,
	sender,
	onSent
}: {
	chat: Chat
	// The composed (ascending) thread list — the ArrowUp-edit-last affordance scans it for the last own message.
	messages: readonly ChatMessage[]
	// uuids of still-pending/failed optimistic entries — excluded from the ArrowUp-edit target (uncommitted).
	nonConfirmedUuids: ReadonlySet<string>
	sender: OptimisticSender | undefined
	// Fired after an own send is enqueued so the thread can jump to the bottom (mobile parity).
	onSent: () => void
}) {
	const { t } = useTranslation("chats")
	const chatUuid = chat.uuid
	const entry = useChatComposerEntry(chatUuid)
	const draft = entry.draft
	const mode = entry.mode

	const setDraft = useChatComposerStore(state => state.setDraft)
	const setMode = useChatComposerStore(state => state.setMode)
	const beginEdit = useChatComposerStore(state => state.beginEdit)
	const reset = useChatComposerStore(state => state.reset)

	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const [caret, setCaret] = useState(0)
	const [activeIndex, setActiveIndex] = useState(0)
	// Escape closes an open popover WITHOUT touching the draft; cleared on the next keystroke so a fresh
	// token re-opens it.
	const [manualClose, setManualClose] = useState(false)
	// Caret to restore after a store-driven value change (mention/emoji insert) lands in the DOM.
	const pendingCaretRef = useRef<number | null>(null)
	const sendingRef = useRef(false)

	// ── Autocomplete derivation (mention wins over emoji when both could match) ──
	const mention = activeMentionQuery(draft, caret)
	const mentionItems: ChatParticipant[] =
		mention !== null ? filterMentionParticipants(chat.participants, mention.query, sender?.id).slice(0, MENTION_LIMIT) : []
	const emoji = mention === null ? activeEmojiQuery(draft, caret) : null
	const emojiItems: EmojiSuggestion[] = emoji !== null ? filterEmojiSuggestions(emoji.query, EMOJI_LIMIT) : []
	const suggestKind: "mention" | "emoji" | null =
		!manualClose && mention !== null && mentionItems.length > 0
			? "mention"
			: !manualClose && emoji !== null && emojiItems.length > 0
				? "emoji"
				: null
	const suggestCount = suggestKind === "mention" ? mentionItems.length : suggestKind === "emoji" ? emojiItems.length : 0
	const safeIndex = suggestCount > 0 ? Math.min(activeIndex, suggestCount - 1) : 0

	const overLimit = isOverLimit(draft)

	// Hydrate the draft from disk once per chat, but never clobber a live draft already in the store (the
	// user may have typed during the async read, or a menu may have loaded an edit body).
	useEffect(() => {
		let cancelled = false

		void loadDraft(chatUuid).then(saved => {
			if (cancelled || saved.length === 0) {
				return
			}

			const current = useChatComposerStore.getState().entries[chatUuid]

			if (current === undefined || (current.draft.length === 0 && current.mode.kind === "new")) {
				setDraft(chatUuid, saved)
			}
		})

		return () => {
			cancelled = true
		}
	}, [chatUuid, setDraft])

	// Mirror the draft to disk (debounced) — a new or reply draft is resumable (mobile persists the input
	// value regardless), but never an edit body (that text belongs to a committed message).
	useEffect(() => {
		if (mode.kind !== "edit") {
			saveDraftDebounced(chatUuid, draft)
		}
	}, [chatUuid, draft, mode.kind])

	// Auto-grow the textarea with its content, up to the cap.
	useLayoutEffect(() => {
		const el = textareaRef.current

		if (el === null) {
			return
		}

		el.style.height = "auto"
		el.style.height = `${String(Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT))}px`
	}, [draft])

	// Focus on chat open + whenever a focus is requested (reply/edit/send/reset bump the nonce), placing
	// the caret at the end.
	useEffect(() => {
		const el = textareaRef.current

		if (el === null) {
			return
		}

		el.focus()
		const end = el.value.length
		el.setSelectionRange(end, end)
		setCaret(end)
	}, [chatUuid, entry.focusNonce])

	// After a mention/emoji insert rewrote the value through the store, restore the intended caret.
	useLayoutEffect(() => {
		const el = textareaRef.current
		const pending = pendingCaretRef.current

		if (el === null || pending === null) {
			return
		}

		pendingCaretRef.current = null
		el.setSelectionRange(pending, pending)
		setCaret(pending)
	}, [draft])

	function syncCaret(): void {
		const el = textareaRef.current

		if (el !== null) {
			setCaret(el.selectionStart)
		}
	}

	function onChange(event: React.ChangeEvent<HTMLTextAreaElement>): void {
		setManualClose(false)
		setDraft(chatUuid, event.target.value)
		setCaret(event.target.selectionStart)

		// Emptying the input while editing cancels the edit (mobile: onChangeText empty clears edit).
		if (event.target.value.length === 0 && mode.kind === "edit") {
			setMode(chatUuid, NEW_MODE)
		}
	}

	function applyReplacement(next: { value: string; caret: number }): void {
		pendingCaretRef.current = next.caret
		setManualClose(false)
		setDraft(chatUuid, next.value)
	}

	function selectMention(participant: ChatParticipant, query: TriggerQuery): void {
		applyReplacement(applyMention(draft, query, participant))
	}

	function selectEmoji(suggestion: EmojiSuggestion, query: TriggerQuery): void {
		applyReplacement(applyEmoji(draft, query, suggestion.char))
	}

	function selectActive(): void {
		if (suggestKind === "mention" && mention !== null) {
			const participant = mentionItems[safeIndex]

			if (participant !== undefined) {
				selectMention(participant, mention)
			}

			return
		}

		if (suggestKind === "emoji" && emoji !== null) {
			const suggestion = emojiItems[safeIndex]

			if (suggestion !== undefined) {
				selectEmoji(suggestion, emoji)
			}
		}
	}

	async function submit(): Promise<void> {
		if (sendingRef.current || !canSend(draft)) {
			return
		}

		const normalized = draft.trim()

		// EDIT — online-best-effort, NOT queued. Keep the text visible while saving; restore on failure.
		if (mode.kind === "edit") {
			sendingRef.current = true
			const outcome = await editMessage(chat, mode.message, normalized)
			sendingRef.current = false

			if (outcome.status === "error") {
				toast.error(errorLabel(outcome.dto))

				return
			}

			reset(chatUuid)

			return
		}

		if (sender === undefined) {
			return
		}

		const replyTo = mode.kind === "reply" ? buildReplyPartial(mode.message) : undefined

		// Optimistic clear FIRST (the outbox paints the bubble + persists), then enqueue. reset() bumps the
		// focus nonce so the input keeps focus after send.
		reset(chatUuid)
		saveDraftDebounced(chatUuid, "")

		const flushed = await enqueueChatMessage({
			chat,
			content: normalized,
			...(replyTo !== undefined ? { replyTo } : {}),
			sender
		})

		if (!flushed) {
			toast.error(t("chatMessageNotSaved"))
		}

		onSent()
	}

	function cancelMode(): void {
		if (mode.kind === "edit") {
			// Discard the loaded body (it isn't a resumable draft).
			reset(chatUuid)

			return
		}

		// Reply: drop the quote, keep whatever was typed.
		setMode(chatUuid, NEW_MODE)
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
		if (suggestKind !== null && suggestCount > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault()
				setActiveIndex(index => (index + 1) % suggestCount)

				return
			}

			if (event.key === "ArrowUp") {
				event.preventDefault()
				setActiveIndex(index => (index - 1 + suggestCount) % suggestCount)

				return
			}

			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault()
				selectActive()

				return
			}

			if (event.key === "Escape") {
				event.preventDefault()
				setManualClose(true)

				return
			}
		}

		const intent = enterIntent(event)

		if (intent === "send") {
			event.preventDefault()
			void submit()

			return
		}

		if (event.key === "Escape" && mode.kind !== "new") {
			event.preventDefault()
			cancelMode()

			return
		}

		// ArrowUp in an empty composer edits the last own message (old-web affordance).
		if (event.key === "ArrowUp" && shouldEditLastOnArrowUp(draft)) {
			const last = lastEditableOwnMessage(messages, sender?.id, nonConfirmedUuids)

			if (last !== undefined) {
				event.preventDefault()
				beginEdit(chatUuid, { kind: "edit", message: last }, last.message ?? "")
			}
		}
	}

	return (
		<div className="relative shrink-0 p-3">
			{suggestKind !== null && suggestCount > 0 ? (
				<div className="absolute right-3 bottom-full left-3 z-10 mb-1 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-md">
					{suggestKind === "mention"
						? mentionItems.map((participant, index) => {
								const name = contactDisplayName(participant)
								const avatarUrl = participant.avatar?.startsWith("http") === true ? participant.avatar : undefined

								return (
									<button
										key={participant.userId.toString()}
										type="button"
										className={cn(
											"flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
											index === safeIndex ? "bg-accent" : "hover:bg-accent/50"
										)}
										onMouseDown={event => {
											// Keep textarea focus (mousedown fires before blur).
											event.preventDefault()

											if (mention !== null) {
												selectMention(participant, mention)
											}
										}}
									>
										<Avatar className="size-7 shrink-0">
											{avatarUrl !== undefined ? <AvatarImage src={avatarUrl} /> : null}
											<AvatarFallback>{contactInitials(name)}</AvatarFallback>
										</Avatar>
										<span className="flex min-w-0 flex-col">
											<span className="truncate text-sm">{name}</span>
											<span className="truncate text-xs text-muted-foreground">{participant.email}</span>
										</span>
									</button>
								)
							})
						: emojiItems.map((suggestion, index) => (
								<button
									key={suggestion.name}
									type="button"
									className={cn(
										"flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
										index === safeIndex ? "bg-accent" : "hover:bg-accent/50"
									)}
									onMouseDown={event => {
										event.preventDefault()

										if (emoji !== null) {
											selectEmoji(suggestion, emoji)
										}
									}}
								>
									<span className="w-7 shrink-0 text-center text-lg">{suggestion.char}</span>
									<span className="truncate text-sm text-muted-foreground">:{suggestion.name}:</span>
								</button>
							))}
				</div>
			) : null}

			{mode.kind === "reply" ? (
				<div className="mb-1.5 flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm">
					<CornerUpLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="shrink-0 font-medium">{t("chatReplyingTo", { name: senderName(mode.message) })}</span>
					{mode.message.message !== undefined && mode.message.message.length > 0 ? (
						<span className="min-w-0 flex-1 truncate text-muted-foreground">{mode.message.message}</span>
					) : (
						<span className="flex-1" />
					)}
					<Button
						variant="ghost"
						size="icon-sm"
						className="size-6 shrink-0"
						aria-label={t("chatComposerCancelReply")}
						onClick={cancelMode}
					>
						<XIcon />
					</Button>
				</div>
			) : null}

			{mode.kind === "edit" ? (
				<div className="mb-1.5 flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm">
					<PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="flex-1 font-medium">{t("chatComposerEditing")}</span>
					<Button
						variant="ghost"
						size="icon-sm"
						className="size-6 shrink-0"
						aria-label={t("chatComposerCancelEdit")}
						onClick={cancelMode}
					>
						<XIcon />
					</Button>
				</div>
			) : null}

			<div className="flex items-end gap-2 rounded-xl bg-muted px-3 py-2">
				<textarea
					ref={textareaRef}
					value={draft}
					onChange={onChange}
					onKeyDown={onKeyDown}
					onKeyUp={syncCaret}
					onClick={syncCaret}
					onSelect={syncCaret}
					rows={1}
					aria-label={t("chatComposerPlaceholder")}
					placeholder={t("chatComposerPlaceholder")}
					className="max-h-[200px] min-h-6 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
				/>
				<div className="flex shrink-0 items-center gap-2">
					{shouldShowCounter(draft) ? (
						<span className={cn("text-xs tabular-nums", overLimit ? "text-destructive" : "text-muted-foreground")}>
							{remainingChars(draft)}
						</span>
					) : null}
					<Button
						size="icon-sm"
						className="size-8 rounded-full"
						disabled={!canSend(draft)}
						aria-label={mode.kind === "edit" ? t("chatComposerSaveEdit") : t("chatComposerSend")}
						onClick={() => {
							void submit()
						}}
					>
						<ArrowUpIcon />
					</Button>
				</div>
			</div>

			{overLimit ? (
				<p className="mt-1 px-1 text-xs text-destructive">{t("chatComposerOverLimit", { max: MAX_CHAT_MESSAGE_LENGTH })}</p>
			) : null}
		</div>
	)
}
