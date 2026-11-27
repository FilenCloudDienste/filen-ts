import { useRef, useState, type CSSProperties } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { HistoryIcon, SquarePenIcon, Trash2Icon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { REVEAL_CLASS } from "@/components/rowReveal"
import { LazyTooltip } from "@/components/lazyTooltip"
import { useNowMinute } from "@/lib/useNowMinute"
import type { AssistantKey } from "@/lib/i18n"
import {
	clearAssistantConversations,
	deleteAssistantConversation,
	modelAcceptsMessages,
	openAssistantConversation,
	setAssistantHistoryOpen,
	startNewAssistantConversation
} from "@/features/assistant/store/assistantSession"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { loadConversationIndex, useAssistantHistoryStore } from "@/features/assistant/store/conversationHistory"
import { useHistoryRetention } from "@/features/assistant/store/historyRetention"
import {
	groupConversations,
	type ConversationMeta,
	type HistoryGroup,
	type HistoryRetention
} from "@/features/assistant/store/history.logic"
import { assistantInitialFocusTarget } from "@/features/assistant/components/assistantFocus"
import { AssistantHistoryList } from "@/features/assistant/components/assistantHistoryList"

const GROUP_KEYS: Record<HistoryGroup, AssistantKey> = {
	today: "assistantHistoryToday",
	yesterday: "assistantHistoryYesterday",
	previous7Days: "assistantHistoryPrevious7Days",
	older: "assistantHistoryOlder"
}

const RETENTION_KEYS: Record<HistoryRetention, AssistantKey> = {
	off: "assistantHistoryNotSaved",
	"1d": "assistantHistoryKept1Day",
	"7d": "assistantHistoryKept7Days",
	"30d": "assistantHistoryKept30Days",
	forever: "assistantHistoryKeptForever"
}

const ROW_CLASS = "group flex items-center gap-1 rounded-xl pr-1 transition-colors"

// The conversation view replaces the list; the composer takes the focus the clicked row took with it.
function showConversation(): void {
	setAssistantHistoryOpen(false)
	requestAnimationFrame(() => {
		assistantInitialFocusTarget()?.focus()
	})
}

async function open(meta: ConversationMeta, failed: string): Promise<void> {
	const result = await openAssistantConversation(meta)

	if (result === "opened") {
		showConversation()
	} else if (result === "missing") {
		toast.error(failed)
		void loadConversationIndex()
	}
}

function ConversationRow({
	meta,
	current,
	openable,
	onDelete,
	style
}: {
	meta: ConversationMeta
	current: boolean
	openable: boolean
	onDelete: (meta: ConversationMeta) => void
	style: CSSProperties
}) {
	const { t } = useTranslation("assistant")
	const title = meta.title.length > 0 ? meta.title : t("assistantHistoryUntitled")

	return (
		<li
			style={style}
			className={cn(
				ROW_CLASS,
				current
					? "bg-sidebar-accent text-sidebar-accent-foreground"
					: "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
			)}
		>
			<button
				type="button"
				aria-current={current ? "true" : undefined}
				title={title}
				disabled={!openable}
				className={cn(
					"min-w-0 flex-1 truncate rounded-xl py-1.5 pl-2.5 text-left text-sm focus-ring outline-none disabled:cursor-default",
					current && "font-medium"
				)}
				onClick={() => {
					void open(meta, t("assistantHistoryOpenFailed"))
				}}
			>
				{title}
			</button>
			<LazyTooltip
				label={t("assistantHistoryDelete", { title })}
				className="flex shrink-0"
			>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={t("assistantHistoryDelete", { title })}
					className={REVEAL_CLASS.plain}
					onClick={() => {
						onDelete(meta)
					}}
				>
					<Trash2Icon />
				</Button>
			</LazyTooltip>
		</li>
	)
}

// The saved conversations, in place of the conversation: a new one, then by last activity grouped by day,
// and clearing them all, with how long they are kept and a link to that setting. setHistoryOpen reads the
// index from storage each time the list opens, never before. Shown in every model state so the conversations
// stay deletable; opening one waits for a usable model, since the setup screen would stand in for it.
export function AssistantHistory() {
	const { t } = useTranslation("assistant")
	const { t: tCommon } = useTranslation("common")
	const openable = useAssistantStore(state => modelAcceptsMessages(state.modelState))
	const conversations = useAssistantHistoryStore(state => state.conversations)
	const currentId = useAssistantHistoryStore(state => state.currentId)
	const retention = useHistoryRetention()
	const now = useNowMinute()
	const [deleting, setDeleting] = useState<ConversationMeta | null>(null)
	const [clearing, setClearing] = useState(false)
	const [pending, setPending] = useState(false)
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const newConversationRef = useRef<HTMLButtonElement | null>(null)
	// Set once a delete went through: the button that opened the dialog went with its row.
	const removedRef = useRef(false)

	function focusAfterClose(): HTMLElement | true {
		if (!removedRef.current) {
			return true
		}

		removedRef.current = false

		const fallback = newConversationRef.current

		return fallback !== null && !fallback.disabled ? fallback : true
	}

	async function remove(run: () => Promise<void>): Promise<void> {
		setPending(true)

		try {
			await run()
			removedRef.current = true
		} catch {
			toast.error(t("assistantHistoryDeleteFailed"))
			void loadConversationIndex()
		}

		setPending(false)
		setDeleting(null)
		setClearing(false)
	}

	const deletingTitle = deleting === null ? "" : deleting.title.length > 0 ? deleting.title : t("assistantHistoryUntitled")

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-3 pb-1">
				<button
					ref={newConversationRef}
					type="button"
					disabled={!openable}
					className="flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm text-sidebar-foreground/80 focus-ring transition-colors outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0"
					onClick={() => {
						startNewAssistantConversation()
						showConversation()
					}}
				>
					<SquarePenIcon />
					{t("assistantNewConversation")}
				</button>
			</div>
			<div
				ref={setScrollElement}
				aria-busy={conversations === null}
				className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto px-3 pb-2"
			>
				{conversations !== null && conversations.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
						<HistoryIcon
							aria-hidden="true"
							className="size-6 text-muted-foreground"
						/>
						<p className="text-sm font-medium">{t("assistantHistoryEmpty")}</p>
						<p className="text-xs text-muted-foreground">
							{t(retention === "off" ? "assistantHistoryOffNote" : "assistantHistoryNote")}
						</p>
					</div>
				) : null}
				{conversations !== null && conversations.length > 0 ? (
					<AssistantHistoryList
						scrollElement={scrollElement}
						groups={groupConversations(conversations, now)}
						label={t("assistantHistoryListLabel")}
						groupLabel={group => t(GROUP_KEYS[group])}
						renderRow={(meta, style) => (
							<ConversationRow
								key={meta.id}
								meta={meta}
								current={meta.id === currentId}
								openable={openable}
								onDelete={setDeleting}
								style={style}
							/>
						)}
					/>
				) : null}
			</div>
			{conversations === null ? null : (
				<div className="flex shrink-0 flex-col gap-1.5 border-t border-border/60 px-4 pt-2 pb-3">
					{conversations.length > 0 ? (
						<>
							{openable ? null : <p className="text-xs text-muted-foreground">{t("assistantHistoryNeedsModel")}</p>}
							<p className="text-xs text-muted-foreground">{t("assistantHistoryNote")}</p>
						</>
					) : null}
					<p className="text-xs text-muted-foreground">
						{t(RETENTION_KEYS[retention])} ·{" "}
						<Link
							to="/settings/assistant"
							aria-label={t("assistantHistoryRetentionChangeLabel")}
							className="rounded-sm text-foreground underline-offset-2 focus-ring outline-none hover:underline"
						>
							{t("assistantHistoryRetentionChange")}
						</Link>
					</p>
					{conversations.length > 0 ? (
						<Button
							variant="ghost"
							size="sm"
							className="self-start text-destructive hover:text-destructive"
							onClick={() => {
								setClearing(true)
							}}
						>
							<Trash2Icon />
							{t("assistantHistoryClear")}
						</Button>
					) : null}
				</div>
			)}
			<ConfirmDialog
				open={deleting !== null}
				pending={pending}
				title={t("assistantHistoryDeleteTitle")}
				body={t("assistantHistoryDeleteBody", { title: deletingTitle })}
				confirmLabel={t("assistantHistoryDeleteConfirm")}
				cancelLabel={tCommon("cancel")}
				destructive
				finalFocus={focusAfterClose}
				onOpenChange={open => {
					if (!open) {
						setDeleting(null)
					}
				}}
				onConfirm={() => {
					if (deleting !== null) {
						const id = deleting.id

						void remove(() => deleteAssistantConversation(id))
					}
				}}
			/>
			<ConfirmDialog
				open={clearing}
				pending={pending}
				title={t("assistantHistoryClearTitle")}
				body={t("assistantHistoryClearBody")}
				confirmLabel={t("assistantHistoryClearConfirm")}
				cancelLabel={tCommon("cancel")}
				destructive
				finalFocus={focusAfterClose}
				onOpenChange={setClearing}
				onConfirm={() => {
					void remove(clearAssistantConversations)
				}}
			/>
		</div>
	)
}
