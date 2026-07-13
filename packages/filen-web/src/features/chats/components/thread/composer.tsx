import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ArrowUpIcon, XIcon, CornerUpLeftIcon, PencilIcon, PaperclipIcon, UploadIcon, HardDriveIcon } from "lucide-react"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import { cn, noop } from "@/lib/utils"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { enqueueChatMessage } from "@/features/chats/lib/sync"
import { signalTyping, signalStopped } from "@/features/chats/lib/typing"
import { editMessage } from "@/features/chats/lib/messageActions"
import { uploadAttachment } from "@/features/chats/lib/attachments"
import type { OptimisticSender } from "@/features/chats/lib/sync.logic"
import {
	MAX_CHAT_MESSAGE_LENGTH,
	canSend,
	isAttachDisabled,
	isOverLimit,
	remainingChars,
	shouldShowCounter,
	enterIntent,
	shouldEditLastOnArrowUp,
	buildReplyPartial,
	appendAttachmentUrl,
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
import { AttachDriveDialog } from "@/features/chats/components/thread/attachDriveDialog"
import { useIsOnline } from "@/lib/useIsOnline"
import { useAccountQuery } from "@/queries/account"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"

// Grow the input with its content up to this many px, then scroll internally (mobile caps at a quarter
// screen; a fixed desktop cap reads cleaner).
const MAX_TEXTAREA_HEIGHT = 200
// Autocomplete popovers cap at this many rows (mobile caps emoji at 10).
const MENTION_LIMIT = 12
const EMOJI_LIMIT = 8

function senderName(message: ChatMessage): string {
	return message.senderNickName !== undefined && message.senderNickName.length > 0 ? message.senderNickName : message.senderEmail
}

// The composer — replaces the earlier disabled strip. EVERY send goes through the durable outbox (enqueueChatMessage),
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
	const { t } = useTranslation(["chats", "common"])
	const isOnline = useIsOnline()
	// Pre-gates the attach menu for a free-tier account, proactively rather than after an upload
	// already ran into the server's own createFileLink/createDirectoryLink rejection (attachments.ts's
	// own header comment). Undefined (still loading) treats as non-Pro — the safe default while the
	// account query is in flight, same posture as gating on `isOnline` before its first paint.
	const isPremium = useAccountQuery().data?.isPremium === true
	const chatUuid = chat.uuid
	const entry = useChatComposerEntry(chatUuid)
	const draft = entry.draft
	const mode = entry.mode

	const setDraft = useChatComposerStore(state => state.setDraft)
	const setMode = useChatComposerStore(state => state.setMode)
	const beginEdit = useChatComposerStore(state => state.beginEdit)
	const reset = useChatComposerStore(state => state.reset)

	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const [caret, setCaret] = useState(0)
	const [activeIndex, setActiveIndex] = useState(0)
	// Count, not a boolean: file-input/drag-drop can hand over several files at once, each its own
	// independent upload (mirrors drive's startUploads fan-out — one failing file never blocks the
	// rest); the attach affordances stay disabled while ANY of them is still in flight.
	const [uploadingCount, setUploadingCount] = useState(0)
	const [attachDriveOpen, setAttachDriveOpen] = useState(false)
	// Escape closes an open popover WITHOUT touching the draft; cleared on the next keystroke so a fresh
	// token re-opens it.
	const [manualClose, setManualClose] = useState(false)
	// Caret to restore after a store-driven value change (mention/emoji insert) lands in the DOM.
	const pendingCaretRef = useRef<number | null>(null)
	const sendingRef = useRef(false)
	// Hold the live chat so the typing "stopped" cleanup keys on chatUuid only — the chat prop's identity
	// changes on every conversation-list cache patch (a socket update mints a new object), which must NOT
	// fire a premature "up" mid-typing. Written in an effect (not during render — React Compiler forbids
	// ref writes in render).
	const chatRef = useRef(chat)

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

	// Keep the ref pointed at the live chat (updated after every render).
	useEffect(() => {
		chatRef.current = chat
	})

	// Emit the throttled "typing" signal on unmount / chat change (the "up" fires only if a "down" is
	// outstanding, so a chat switch mid-typing tells the peer we stopped).
	useEffect(() => {
		return () => {
			signalStopped(chatRef.current)
		}
	}, [chatUuid])

	function onChange(event: React.ChangeEvent<HTMLTextAreaElement>): void {
		setManualClose(false)
		setDraft(chatUuid, event.target.value)
		setCaret(event.target.selectionStart)

		// Fire the throttled typing signal on every keystroke (the controller owns the throttle + idle "up").
		signalTyping(chat)

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
		// Standard completes to its unicode glyph; a custom (image-backed, non-unicode) shortcode has no
		// glyph to insert, so it completes to the literal `:name:` token instead — the same text the
		// message-render pipeline resolves back to the bundled image (emoji.ts / messageContent.tsx).
		const replacement = suggestion.kind === "standard" ? suggestion.char : `:${suggestion.name}:`

		applyReplacement(applyEmoji(draft, query, replacement))
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

	// Appends a just-created attachment url to whichever draft is live AT THE TIME it resolves — reads
	// fresh store state rather than closing over the render's own `draft`, since an upload can easily
	// outlive several keystrokes (or, for a multi-file drop, several sibling uploads finishing out of
	// order — each append must stack on the LATEST value, never clobber a concurrent one).
	function insertAttachmentUrl(url: string): void {
		const current = useChatComposerStore.getState().entries[chatUuid]?.draft ?? ""
		setDraft(chatUuid, appendAttachmentUrl(current, url))
	}

	// One file → one upload → one link → one append. Every step is confirm-then-patch with an
	// errorLabel toast (attachments.ts's own header comment); a premium-gate rejection on the
	// enablePublicLink leg surfaces the SERVER's own label here, unaltered — the FREE e2e account's
	// expected path (spec item 4).
	async function attachLocalFile(file: File): Promise<void> {
		setUploadingCount(count => count + 1)

		try {
			const outcome = await uploadAttachment(file, noop)

			if (outcome.status === "error") {
				toast.error(errorLabel(outcome.dto))
				return
			}

			insertAttachmentUrl(outcome.url)
		} finally {
			setUploadingCount(count => count - 1)
		}
	}

	function attachLocalFiles(files: FileList | File[]): void {
		for (const file of files) {
			void attachLocalFile(file)
		}
	}

	function onDrop(event: React.DragEvent<HTMLDivElement>): void {
		if (event.dataTransfer.files.length === 0) {
			return
		}

		event.preventDefault()
		attachLocalFiles(event.dataTransfer.files)
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

		// Guard the send path too (mobile guards both): a sub-frame double-Enter would otherwise reuse this
		// render's stale draft closure and enqueue twice with distinct inflightIds → a duplicate send.
		sendingRef.current = true

		const replyTo = mode.kind === "reply" ? buildReplyPartial(mode.message) : undefined

		// A send ends the typing burst — tell the peer we stopped (mobile fires "up" on send).
		signalStopped(chat)

		// Optimistic clear FIRST (the outbox paints the bubble + persists), then enqueue. reset() bumps the
		// focus nonce so the input keeps focus after send.
		reset(chatUuid)
		saveDraftDebounced(chatUuid, "")

		// Stick to the bottom BEFORE the enqueue: enqueueChatMessage paints the optimistic bubble
		// synchronously (growing the thread's row count) before its own disk await, so the flag must be set
		// ahead of that paint or the thread's grow-triggered jump-to-bottom effect fires without it.
		onSent()

		try {
			const flushed = await enqueueChatMessage({
				chat,
				content: normalized,
				...(replyTo !== undefined ? { replyTo } : {}),
				sender
			})

			if (!flushed) {
				toast.error(t("chatMessageNotSaved"))
			}
		} finally {
			sendingRef.current = false
		}
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
		<div
			className="relative shrink-0 p-3"
			onDragOver={event => {
				event.preventDefault()
			}}
			onDrop={onDrop}
		>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				className="hidden"
				onChange={event => {
					if (event.target.files !== null) {
						attachLocalFiles(event.target.files)
					}

					// Reset so selecting the SAME file twice in a row still fires onChange the second time.
					event.target.value = ""
				}}
			/>
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
											{/* crossOrigin: require-corp COEP needs a CORS-mode request for this
											    cross-origin egest url (see avatarCard.tsx's matching comment). */}
											{avatarUrl !== undefined ? (
												<AvatarImage
													src={avatarUrl}
													crossOrigin="anonymous"
												/>
											) : null}
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
									key={`${suggestion.kind}-${suggestion.name}`}
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
										<span className="w-7 shrink-0 text-center text-lg">{suggestion.char}</span>
									)}
									<span className="truncate text-sm text-muted-foreground">:{suggestion.name}:</span>
								</button>
							))}
				</div>
			) : null}

			{/* Reply/edit banner + input field are one visually-joined docked unit — a single rounded,
			softly-bordered field (Discord's own composer treatment, lighter than the surrounding thread)
			with the active reply/edit strip flush atop the textarea, separated only by a thin rule. */}
			<div className="rounded-2xl border border-input bg-background transition-colors focus-within:border-ring/60">
				{mode.kind === "reply" ? (
					<div className="flex items-center gap-2 border-b border-input px-3 py-1.5 text-sm">
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
					<div className="flex items-center gap-2 border-b border-input px-3 py-1.5 text-sm">
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

				<div className="flex items-end gap-2 px-3 py-2">
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									className="size-8 shrink-0 self-end rounded-full"
									// Attach-menu pre-gate — both entries need network right away (an upload/
									// drive-attach start, not a durably-queued send), unlike the send button below,
									// which stays enabled offline by design (its outbox queues and flushes later).
									// Also pre-gated on Pro status — offline wins the tooltip when both apply, since
									// reconnecting alone can't fix a non-Pro rejection but going online can.
									disabled={isAttachDisabled(uploadingCount, isOnline, isPremium)}
									aria-label={t("chatComposerAttach")}
									title={
										!isOnline
											? t("common:offlineActionDisabled")
											: !isPremium
												? t("chatComposerAttachPremiumRequired")
												: undefined
									}
								>
									<PaperclipIcon />
								</Button>
							}
						/>
						<DropdownMenuContent align="start">
							<DropdownMenuItem
								onClick={() => {
									fileInputRef.current?.click()
								}}
							>
								<UploadIcon aria-hidden="true" />
								{t("chatComposerAttachUpload")}
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => {
									setAttachDriveOpen(true)
								}}
							>
								<HardDriveIcon aria-hidden="true" />
								{t("chatComposerAttachFromDrive")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<textarea
						ref={textareaRef}
						value={draft}
						onChange={onChange}
						onKeyDown={onKeyDown}
						onKeyUp={syncCaret}
						onClick={syncCaret}
						onSelect={syncCaret}
						onBlur={() => {
							// Leaving the input ends the typing burst (mobile fires "up" onBlur).
							signalStopped(chat)
						}}
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
			</div>

			{overLimit ? (
				<p className="mt-1 px-1 text-xs text-destructive">{t("chatComposerOverLimit", { max: MAX_CHAT_MESSAGE_LENGTH })}</p>
			) : null}

			{attachDriveOpen ? (
				<AttachDriveDialog
					onClose={() => {
						setAttachDriveOpen(false)
					}}
					onAttached={url => {
						insertAttachmentUrl(url)
						setAttachDriveOpen(false)
					}}
				/>
			) : null}
		</div>
	)
}
