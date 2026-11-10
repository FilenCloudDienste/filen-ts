import { useRef, type ChangeEvent, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUpIcon, SquareIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { GLASS_SURFACE_CLASS } from "@/components/ui/surface"
import { isImeKeydown } from "@filen/shared/keymap"
import { enterIntent } from "@/features/chats/lib/composer.logic"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { awaitingConfirmation } from "@/features/assistant/store/transcript"
import { cancelAssistantTurn, noteAssistantActivity, sendAssistantMessage } from "@/features/assistant/store/assistantSession"
import { assistantInitialFocusTarget } from "@/features/assistant/components/assistantFocus"

const MAX_TEXTAREA_HEIGHT = 160

// Sized from the input handlers rather than an effect on the draft: every change that alters the content
// passes through one of them.
function fitHeight(element: HTMLTextAreaElement): void {
	element.style.height = "auto"
	element.style.height = `${String(Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT))}px`
}

// The draft outlives the composer (panel closed, history shown, drawer closed), so a restored one is sized
// as it mounts.
function sizeRestoredDraft(element: HTMLDivElement | null): void {
	const textarea = element?.querySelector("textarea")

	if (textarea !== null && textarea !== undefined && textarea.value.length > 0) {
		fitHeight(textarea)
	}
}

// The chat composer's pill, minus attachments. Enter sends, Shift+Enter breaks the line, and an IME
// composition's own Enter (confirming a candidate, which Safari delivers after the composition ended) is
// left to the IME. While a reply streams, Stop replaces Send; the draft stays editable so the next question
// can be typed meanwhile. While the turn only waits for its card, Send is back: a new message answers the
// card with no.
export function AssistantComposer() {
	const { t } = useTranslation("assistant")
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const draft = useAssistantStore(state => state.draft)
	const setDraft = useAssistantStore(state => state.setDraft)
	const busy = useAssistantStore(state => state.activeTurnId !== null && !awaitingConfirmation(state))
	const canSend = !busy && draft.trim().length > 0

	function submit(): void {
		if (!canSend || !sendAssistantMessage(draft)) {
			return
		}

		setDraft("")

		if (textareaRef.current !== null) {
			textareaRef.current.style.height = ""
		}
	}

	function onChange(event: ChangeEvent<HTMLTextAreaElement>): void {
		noteAssistantActivity()
		setDraft(event.target.value)
		fitHeight(event.target)
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (isImeKeydown(event.nativeEvent) || enterIntent(event) !== "send") {
			return
		}

		event.preventDefault()
		submit()
	}

	return (
		<div
			ref={sizeRestoredDraft}
			className="shrink-0 px-3 pt-2 pb-3"
		>
			<div
				className={cn(
					"flex items-end gap-2 rounded-[20px] py-1 pr-1 pl-4 transition-shadow focus-within:ring-3 focus-within:ring-ring/30",
					GLASS_SURFACE_CLASS
				)}
			>
				<textarea
					ref={textareaRef}
					data-assistant-autofocus=""
					value={draft}
					onChange={onChange}
					onKeyDown={onKeyDown}
					rows={1}
					aria-label={t("assistantComposerPlaceholder")}
					placeholder={t("assistantComposerPlaceholder")}
					className="max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm leading-5 outline-none placeholder:text-muted-foreground"
				/>
				{busy ? (
					<Button
						size="icon-sm"
						variant="secondary"
						className="rounded-full"
						aria-label={t("assistantStop")}
						onClick={() => {
							// The button turns into a disabled Send once the turn ends, which would drop focus to the page.
							assistantInitialFocusTarget()?.focus()
							cancelAssistantTurn()
						}}
					>
						<SquareIcon className="size-3.5 fill-current" />
					</Button>
				) : (
					<Button
						size="icon-sm"
						className="rounded-full bg-chat-own text-chat-own-foreground hover:bg-chat-own-strong"
						disabled={!canSend}
						aria-label={t("assistantSend")}
						onClick={submit}
					>
						<ArrowUpIcon className="size-4" />
					</Button>
				)}
			</div>
		</div>
	)
}
