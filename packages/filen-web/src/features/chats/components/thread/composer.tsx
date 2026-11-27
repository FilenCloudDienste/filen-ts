import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useNavigate } from "@tanstack/react-router"
import { ArrowUpIcon, PlusIcon, UploadIcon, HardDriveIcon, SparklesIcon } from "lucide-react"
import type { Chat, ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import { cn, isProAccount } from "@filen/shared"
import { isImeKeydown, isMacPlatform } from "@filen/shared/keymap"
import { useComboFor } from "@/lib/keymap/registry"
import { insertLineBreak, wrapInlineCode } from "@/features/chats/lib/keyboard.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { enqueueChatMessage } from "@/features/chats/lib/sync"
import { signalTyping, signalStopped } from "@/features/chats/lib/typing"
import { editMessage } from "@/features/chats/lib/messageActions"
import { preflightAttachments, uploadAttachment } from "@/features/chats/lib/attachments"
import {
	MAX_CHAT_MESSAGE_LENGTH,
	canSend,
	isAttachDisabled,
	isOverLimit,
	remainingChars,
	shouldShowCounter,
	composerKeyIntent,
	isNativeLineBreak,
	shouldEditLastOnArrowUp,
	buildReplyPartial,
	appendAttachmentUrl,
	activeMentionQuery,
	activeEmojiQuery,
	filterMentionParticipants,
	applyMention,
	applyEmoji,
	lastEditableOwnMessage,
	NEW_MODE,
	type ComposerKeys,
	type TriggerQuery
} from "@/features/chats/lib/composer.logic"
import { searchEmoji, type EmojiSuggestion } from "@/features/chats/lib/emoji"
import { insertEmojiAt } from "@/features/chats/lib/emojiPicker.logic"
import { EmojiPicker } from "@/features/chats/components/thread/emojiPicker"
import { chatTitle } from "@/features/chats/lib/sort"
import { useChatComposerEntry, useChatComposerStore } from "@/features/chats/store/useChatComposer"
import { deleteDraft, loadDraft, saveDraftDebounced } from "@/features/chats/lib/drafts"
import { beginMessageEdit, endMessageEdit } from "@/features/chats/lib/composerEdit"
import { AttachDriveDialog } from "@/features/chats/components/thread/attachDriveDialog"
import { ComposerModeBanner } from "@/features/chats/components/thread/composerModeBanner"
import { ComposerSuggestions, type ComposerSuggestionList } from "@/features/chats/components/thread/composerSuggestions"
import { suggestionOptionId } from "@/features/chats/components/thread/composerSuggestions.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { toastObstructionRef } from "@/lib/toastClearance"
import { useAccountQuery } from "@/queries/account"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DisabledReason, EXPLAINED_DISABLED_CLASS, TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { GLASS_SURFACE_CLASS } from "@/components/ui/surface"
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuGroup,
	DropdownMenuLabel
} from "@/components/ui/dropdown-menu"
import { isDesktopBilling, openWebBilling } from "@/features/settings/lib/billingLinks"
import { textFieldTransform } from "@/features/assistant/transform/host"
import { SelectionTransform } from "@/features/assistant/transform/selectionTransform"

// Grow the input with its content up to this many px, then scroll internally (mobile caps at a quarter
// screen; a fixed desktop cap reads cleaner).
const MAX_TEXTAREA_HEIGHT = 200
// Autocomplete popovers cap at this many rows (mobile caps emoji at 10).
const MENTION_LIMIT = 12
const EMOJI_LIMIT = 8
const IS_MAC = isMacPlatform()

// The composer. EVERY send goes through the durable outbox (enqueueChatMessage),
// never sdkApi.sendChatMessage directly, so a send survives a window close / lost connection. Edits are
// the one exception: online-best-effort (editMessage), NOT outbox-queued, mirroring mobile/old-web. The
// send button is disabled only on an empty / over-limit body — NEVER offline (an offline send queues, the
// whole point). Draft/reply/edit live in the per-chat composer store (survive navigation); the draft also
// mirrors to disk for cross-reload durability.
export function Composer({
	chat,
	messages,
	nonConfirmedUuids,
	onSent
}: {
	chat: Chat
	// The composed (ascending) thread list — the ArrowUp-edit-last affordance scans it for the last own message.
	messages: readonly ChatMessage[]
	// uuids of still-pending/failed optimistic entries — excluded from the ArrowUp-edit target (uncommitted).
	nonConfirmedUuids: ReadonlySet<string>
	// Fired after an own send is enqueued so the thread can jump to the bottom (mobile parity).
	onSent: () => void
}) {
	const { t } = useTranslation(["chats", "common", "settings"])
	const navigate = useNavigate()
	const isOnline = useIsOnline()
	const sender = useAccountQuery().data
	// Pre-gates the attach menu for a free-tier account, proactively rather than after an upload
	// already ran into the server's own createFileLink/createDirectoryLink rejection (attachments.ts's
	// own header comment). Undefined (still loading) treats as non-Pro — the safe default while the
	// account query is in flight, same posture as gating on `isOnline` before its first paint.
	// Pro as the backend decides it when it accepts or refuses the attachment's link (isUserPro: any activated
	// subscription), not the account's premium flag (one-off purchases only, never reset).
	const isPro = sender !== undefined && isProAccount(sender.subs)
	const chatUuid = chat.uuid
	const entry = useChatComposerEntry(chatUuid)
	const draft = entry.draft
	const mode = entry.mode

	const setDraft = useChatComposerStore(state => state.setDraft)
	const setMode = useChatComposerStore(state => state.setMode)
	const reset = useChatComposerStore(state => state.reset)
	// The message field's keys, live (Settings → Keyboard), matched by its own keydown below.
	const keys: ComposerKeys = {
		send: useComboFor("chats.composer.send"),
		newline: useComboFor("chats.composer.newline"),
		editLast: useComboFor("chats.composer.editLast"),
		cancel: useComboFor("chats.composer.cancel"),
		inlineCode: useComboFor("chats.composer.inlineCode"),
		attach: useComboFor("chats.composer.attach"),
		attachFromDrive: useComboFor("chats.composer.attachFromDrive")
	}

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
	// Selection to restore after a store-driven value change (mention/emoji insert, a line break, inline code) lands in
	// the DOM.
	const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null)
	const sendingRef = useRef(false)
	// Hold the live chat so the typing "stopped" cleanup keys on chatUuid only — the chat prop's identity
	// changes on every conversation-list cache patch (a socket update mints a new object), which must NOT
	// fire a premature "up" mid-typing. Written in an effect (not during render — React Compiler forbids
	// ref writes in render).
	const chatRef = useRef(chat)
	// The assistant's selection transform: the browser's own insertText into the field (its undo takes it back, its
	// input event reaches onChange), else the draft set directly with the selection restored.
	const [transform] = useState(textFieldTransform)
	const [transformRoot, setTransformRoot] = useState<HTMLDivElement | null>(null)

	useEffect(() => {
		transform.attach(textareaRef.current, (value, selection) => {
			pendingSelectionRef.current = selection
			setManualClose(false)
			setDraft(chatUuid, value)
		})
	})

	// ── Autocomplete derivation (mention wins over emoji when both could match) ──
	const mention = activeMentionQuery(draft, caret)
	const mentionItems: ChatParticipant[] =
		mention !== null ? filterMentionParticipants(chat.participants, mention.query, sender?.id).slice(0, MENTION_LIMIT) : []
	const emoji = mention === null ? activeEmojiQuery(draft, caret) : null
	const emojiItems: EmojiSuggestion[] = emoji !== null ? searchEmoji(emoji.query, EMOJI_LIMIT) : []
	const suggestList: ComposerSuggestionList | null = manualClose
		? null
		: mention !== null && mentionItems.length > 0
			? { kind: "mention", items: mentionItems }
			: emoji !== null && emojiItems.length > 0
				? { kind: "emoji", items: emojiItems }
				: null
	const suggestCount = suggestList !== null ? suggestList.items.length : 0
	const safeIndex = suggestCount > 0 ? Math.min(activeIndex, suggestCount - 1) : 0
	const listboxId = useId()

	const overLimit = isOverLimit(draft)
	const showCounter = shouldShowCounter(draft)
	const remaining = remainingChars(draft)
	const counterId = useId()
	const overLimitId = useId()
	// The field's description: the counter while shown, the limit error while over it.
	const describedBy = [showCounter ? counterId : null, overLimit ? overLimitId : null].filter(id => id !== null).join(" ")
	// Why attaching is refused (trigger tooltip, drop toast). Offline wins when both apply: going online fixes
	// that one, while reconnecting alone can't fix a non-Pro rejection.
	const attachGateReason = !isOnline ? t("common:offlineActionDisabled") : !isPro ? t("chatComposerAttachPremiumRequired") : undefined
	// A free account opens the menu to learn why and upgrade; only offline, an upload in flight or a still-loading
	// account keep the trigger off.
	const attachTriggerDisabled = sender === undefined || isAttachDisabled(uploadingCount, isOnline, true)
	const attachReasonId = useId()
	// A trigger turned off with a reason stays hoverable (aria-disabled) so its tooltip can say why.
	const attachExplained = attachTriggerDisabled && attachGateReason !== undefined

	function upgrade(): void {
		if (isDesktopBilling()) {
			openWebBilling()

			return
		}

		void navigate({ to: "/settings/plans" })
	}

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

	// After an insert rewrote the value through the store, restore the intended selection.
	useLayoutEffect(() => {
		const el = textareaRef.current
		const pending = pendingSelectionRef.current

		if (el === null || pending === null) {
			return
		}

		pendingSelectionRef.current = null
		el.setSelectionRange(pending.start, pending.end)
		setCaret(pending.end)
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

	// Emptying the input keeps an edit open (unlike mobile): ending it would put the pre-edit draft back
	// into the field under the key still deleting, and an empty edit cannot be saved anyway.
	function onChange(event: React.ChangeEvent<HTMLTextAreaElement>): void {
		setManualClose(false)
		setDraft(chatUuid, event.target.value)
		setCaret(event.target.selectionStart)

		// Fire the throttled typing signal on every keystroke (the controller owns the throttle + idle "up").
		signalTyping(chat)
	}

	function applyReplacement(next: { value: string; caret: number }): void {
		pendingSelectionRef.current = { start: next.caret, end: next.caret }
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

	// A pick from the emoji picker goes in at the field's caret (or over its selection), which the field keeps while the
	// picker has focus; the picker hands focus back to the field as it closes.
	function insertPickedEmoji(text: string): void {
		const el = textareaRef.current
		const start = el?.selectionStart ?? draft.length
		const end = el?.selectionEnd ?? start

		applyReplacement(insertEmojiAt(draft, start, end, text))
	}

	function selectActive(): void {
		if (suggestList?.kind === "mention" && mention !== null) {
			const participant = mentionItems[safeIndex]

			if (participant !== undefined) {
				selectMention(participant, mention)
			}

			return
		}

		if (suggestList?.kind === "emoji" && emoji !== null) {
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
	// errorLabel toast (attachments.ts's own header comment); a premium-gate rejection that gets past the
	// isPro pre-gate surfaces the SERVER's own label here, unaltered.
	async function attachLocalFile(file: File): Promise<void> {
		setUploadingCount(count => count + 1)

		// .finally() rather than try/finally: the compiler can't compile a try without a catch.
		const outcome = await uploadAttachment(file).finally(() => {
			setUploadingCount(count => count - 1)
		})

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		insertAttachmentUrl(outcome.url)
	}

	async function attachLocalFiles(files: FileList | File[]): Promise<void> {
		// Copied before the await: the input's FileList empties once its value is reset.
		const picked = Array.from(files)

		if (picked.length === 0) {
			return
		}

		// The pre-flight's quota read counts as an upload in flight, so a second drop during it is refused
		// too. Each file's own count is taken before this one is released.
		setUploadingCount(count => count + 1)

		if (await preflightAttachments(picked)) {
			for (const file of picked) {
				void attachLocalFile(file)
			}
		}

		setUploadingCount(count => count - 1)
	}

	function onDrop(event: React.DragEvent<HTMLDivElement>): void {
		if (event.dataTransfer.files.length === 0) {
			return
		}

		// Prevented even when refused, so the browser never navigates to the dropped file.
		event.preventDefault()

		// Same gate as the attach menu trigger: a drop is the one path to an upload that bypasses it.
		if (isAttachDisabled(uploadingCount, isOnline, isPro)) {
			if (isOnline && uploadingCount === 0 && !isPro) {
				toast.error(t("chatComposerAttachPremiumRequired"), {
					action: { label: t("settings:settingsStorageFullUpgrade"), onClick: upgrade }
				})

				return
			}

			toast.error(attachGateReason ?? t("chatComposerAttachInProgress"))

			return
		}

		void attachLocalFiles(event.dataTransfer.files)
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

			endMessageEdit(chatUuid, mode.message.uuid)

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
		// Deleted at once, not debounced: a reload right after the send must not bring the sent text back.
		void deleteDraft(chatUuid)

		// Stick to the bottom BEFORE the enqueue: enqueueChatMessage paints the optimistic bubble
		// synchronously (growing the thread's row count) before its own disk await, so the flag must be set
		// ahead of that paint or the thread's grow-triggered jump-to-bottom effect fires without it.
		onSent()

		const flushed = await enqueueChatMessage({
			chat,
			content: normalized,
			...(replyTo !== undefined ? { replyTo } : {}),
			sender
		}).finally(() => {
			sendingRef.current = false
		})

		if (!flushed) {
			toast.error(t("chatMessageNotSaved"))
		}
	}

	function cancelMode(): void {
		if (mode.kind === "edit") {
			// Discard the loaded body (it isn't a resumable draft) and bring back what was typed before.
			endMessageEdit(chatUuid)

			return
		}

		// Reply: drop the quote, keep whatever was typed.
		setMode(chatUuid, NEW_MODE)
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
		// A key an input method composes with is the composition's: its Enter commits the text, never sends it.
		if (isImeKeydown(event.nativeEvent)) {
			return
		}

		if (suggestCount > 0) {
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

		const intent = composerKeyIntent(event.nativeEvent, keys, IS_MAC)

		if (intent === "send") {
			event.preventDefault()
			void submit()

			return
		}

		// Shift+Enter is the field's own line break (and keeps the browser's undo); any other binding inserts one.
		if (intent === "newline") {
			if (!isNativeLineBreak(event)) {
				event.preventDefault()
				insertNewline(event.currentTarget)
			}

			return
		}

		if (intent === "cancel" && mode.kind !== "new") {
			event.preventDefault()
			cancelMode()

			return
		}

		// In an empty composer, edits the last own message (old-web affordance).
		if (intent === "editLast" && shouldEditLastOnArrowUp(draft)) {
			const last = lastEditableOwnMessage(messages, sender?.id, nonConfirmedUuids)

			if (last !== undefined) {
				event.preventDefault()
				beginMessageEdit(chatUuid, last)
			}

			return
		}

		if (intent === "inlineCode") {
			event.preventDefault()
			wrapSelectionInCode(event.currentTarget)

			return
		}

		if (intent === "attach") {
			event.preventDefault()

			// The menu trigger's own gate; a free account learns why from the menu itself.
			if (isPro && !isAttachDisabled(uploadingCount, isOnline, isPro)) {
				fileInputRef.current?.click()
			}

			return
		}

		if (intent === "attachFromDrive") {
			event.preventDefault()

			if (isPro && !isAttachDisabled(uploadingCount, isOnline, isPro)) {
				setAttachDriveOpen(true)
			}
		}
	}

	function insertNewline(field: HTMLTextAreaElement): void {
		applyReplacement(insertLineBreak(draft, field.selectionStart, field.selectionEnd))
	}

	function wrapSelectionInCode(field: HTMLTextAreaElement): void {
		const next = wrapInlineCode(draft, field.selectionStart, field.selectionEnd)

		pendingSelectionRef.current = { start: next.selectionStart, end: next.selectionEnd }
		setManualClose(false)
		setDraft(chatUuid, next.value)
	}

	return (
		<div
			ref={toastObstructionRef}
			className="shrink-0 px-4 pt-2 pb-4"
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
						void attachLocalFiles(event.target.files)
					}

					// Reset so selecting the SAME file twice in a row still fires onChange the second time.
					event.target.value = ""
				}}
			/>
			{mode.kind !== "new" ? (
				<div className="mb-2">
					<ComposerModeBanner
						kind={mode.kind}
						message={mode.message}
						currentUserId={sender?.id}
						onCancel={cancelMode}
					/>
				</div>
			) : null}
			{/* The popover is the box's sibling, not its child, so the box's rounded clip never cuts it off. */}
			<div
				ref={setTransformRoot}
				className="relative"
			>
				<SelectionTransform
					host={transform.host}
					root={transformRoot}
				/>
				{/* Announces that suggestions opened (the listbox itself is driven by aria-activedescendant). */}
				<div
					aria-live="polite"
					className="sr-only"
				>
					{suggestCount > 0 ? t("chatComposerSuggestionCount", { count: suggestCount }) : null}
				</div>
				{suggestList !== null ? (
					<ComposerSuggestions
						listboxId={listboxId}
						list={suggestList}
						activeIndex={safeIndex}
						onSelectMention={participant => {
							if (mention !== null) {
								selectMention(participant, mention)
							}
						}}
						onSelectEmoji={suggestion => {
							if (emoji !== null) {
								selectEmoji(suggestion, emoji)
							}
						}}
					/>
				) : null}
				<div
					className={cn(
						"flex items-end gap-1 rounded-xl p-1 transition-shadow focus-within:ring-ring/50 dark:focus-within:ring-ring/50",
						GLASS_SURFACE_CLASS
					)}
				>
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger
								render={
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon-sm"
												className={cn(
													"rounded-full text-muted-foreground",
													attachExplained && EXPLAINED_DISABLED_CLASS
												)}
												// Attach-menu pre-gate — both entries need network right away (an upload/
												// drive-attach start, not a durably-queued send), unlike the send button below,
												// which stays enabled offline by design (its outbox queues and flushes later).
												// A free account gets the reason and an upgrade inside instead.
												disabled={attachTriggerDisabled}
												focusableWhenDisabled={attachExplained}
												aria-label={t("chatComposerAttach")}
												aria-describedby={attachExplained ? attachReasonId : undefined}
											>
												<PlusIcon />
												<DisabledReason
													id={attachReasonId}
													reason={attachExplained ? attachGateReason : undefined}
												/>
											</Button>
										}
									/>
								}
							/>
							<TooltipContent>
								{attachGateReason ?? t("chatComposerAttach")}
								{attachGateReason === undefined ? <Kbd action="chats.composer.attach" /> : null}
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent
							align="start"
							side="top"
							sideOffset={8}
							className="w-auto"
						>
							{isPro ? (
								<>
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
								</>
							) : (
								<DropdownMenuGroup>
									<DropdownMenuLabel className="max-w-64 font-normal whitespace-normal">
										{t("chatComposerAttachPremiumRequired")}
									</DropdownMenuLabel>
									<DropdownMenuItem onClick={upgrade}>
										<SparklesIcon aria-hidden="true" />
										{t("settings:settingsStorageFullUpgrade")}
									</DropdownMenuItem>
								</DropdownMenuGroup>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
					<EmojiPicker
						returnFocusRef={textareaRef}
						onPick={insertPickedEmoji}
					/>
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
						aria-autocomplete="list"
						aria-expanded={suggestList !== null}
						aria-controls={suggestList !== null ? listboxId : undefined}
						aria-activedescendant={suggestList !== null ? suggestionOptionId(listboxId, safeIndex) : undefined}
						aria-invalid={overLimit}
						aria-describedby={describedBy.length > 0 ? describedBy : undefined}
						aria-errormessage={overLimit ? overLimitId : undefined}
						placeholder={t("chatComposerPlaceholderChat", {
							name: chatTitle(chat, sender?.id, t("chatUndecryptable"), t("chatJustYou"))
						})}
						className="max-h-[200px] min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:text-muted-foreground"
					/>
					{showCounter ? (
						<span
							id={counterId}
							className={cn(
								"shrink-0 text-xs leading-7 tabular-nums",
								overLimit ? "font-medium text-destructive" : "text-muted-foreground"
							)}
						>
							<span aria-hidden="true">{remaining}</span>
							<span className="sr-only">
								{overLimit
									? t("chatComposerCharsOver", { count: -remaining })
									: t("chatComposerCharsRemaining", { count: remaining })}
							</span>
						</span>
					) : null}
					<TooltipIconButton
						variant="default"
						className="rounded-full bg-chat-own text-chat-own-foreground hover:bg-chat-own-strong"
						// No sender until the account has loaded, and submit() cannot send without one: an enabled
						// button (or Enter) would do nothing, silently, keeping the text.
						disabled={!canSend(draft) || sender === undefined}
						label={mode.kind === "edit" ? t("chatComposerSaveEdit") : t("chatComposerSend")}
						shortcut={<Kbd action="chats.composer.send" />}
						onClick={() => {
							void submit()
						}}
					>
						<ArrowUpIcon className="size-4" />
					</TooltipIconButton>
				</div>
			</div>

			{overLimit ? (
				<p
					id={overLimitId}
					role="alert"
					className="mt-1.5 px-1 text-xs text-destructive"
				>
					{t("chatComposerOverLimit", { max: MAX_CHAT_MESSAGE_LENGTH })}
				</p>
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
