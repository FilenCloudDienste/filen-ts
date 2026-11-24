import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { EllipsisIcon, HistoryIcon, SquarePenIcon, Trash2Icon, XIcon } from "lucide-react"
import { cn, formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Kbd } from "@/lib/keymap/kbd"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import {
	modelAcceptsMessages,
	removeAssistantModel,
	setAssistantHistoryOpen,
	startNewAssistantConversation
} from "@/features/assistant/store/assistantSession"
import { useAssistantHistoryStore } from "@/features/assistant/store/conversationHistory"
import { ASSISTANT_TITLE_ID, assistantInitialFocusTarget } from "@/features/assistant/components/assistantFocus"
import { canRemoveModel, downloadPercent, modelShowsLoading, removableModelBytes } from "@/features/assistant/components/assistant.logic"
import type { AssistantModelState } from "@/features/assistant/types"

const CHIP_CLASS = "shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium"

function StatusChip({ state, turnActive }: { state: AssistantModelState; turnActive: boolean }) {
	const { t } = useTranslation("assistant")

	switch (state.kind) {
		case "checking":
			return null
		case "unavailable":
			return (
				<span className={cn(CHIP_CLASS, "bg-muted text-muted-foreground")}>
					{state.reason === "in-use-elsewhere" ? t("assistantStatusInUseElsewhere") : t("assistantStatusUnavailable")}
				</span>
			)
		case "not-downloaded":
			return <span className={cn(CHIP_CLASS, "bg-muted text-muted-foreground")}>{t("assistantStatusNotDownloaded")}</span>
		case "downloading":
			// Finishing reads as 100%: the bytes are in, only bookkeeping is left, so it cannot be waiting.
			return state.waiting && state.receivedBytes < state.model.sizeBytes ? (
				<span className={cn(CHIP_CLASS, "bg-muted text-muted-foreground")}>{t("assistantStatusDownloadWaiting")}</span>
			) : (
				<span className={cn(CHIP_CLASS, "bg-primary/10 text-primary tabular-nums")}>
					{t("assistantStatusDownloading", { percent: downloadPercent(state.receivedBytes, state.model.sizeBytes) })}
				</span>
			)
		case "downloaded":
		case "loading":
			return modelShowsLoading(state, turnActive) ? (
				<span className={cn(CHIP_CLASS, "bg-primary/10 text-primary")}>{t("assistantStatusLoading")}</span>
			) : (
				<span className={cn(CHIP_CLASS, "bg-muted text-muted-foreground")}>{t("assistantStatusNotLoaded")}</span>
			)
		case "ready":
			return <span className={cn(CHIP_CLASS, "bg-primary/10 text-primary")}>{t("assistantStatusReady")}</span>
		case "error":
			return <span className={cn(CHIP_CLASS, "bg-destructive/10 text-destructive")}>{t("assistantStatusError")}</span>
	}
}

// Only offered while the files are on disk; confirmed first, since getting them back is a multi-gigabyte
// download.
function ModelMenu({ state }: { state: AssistantModelState }) {
	const { t } = useTranslation(["assistant", "common"])
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [pending, setPending] = useState(false)

	// Removing the model takes this menu, the dialog's way back, with it: focus goes to the screen that
	// replaced the conversation instead, once it is in the DOM.
	function focusAfterClose(): boolean {
		if (canRemoveModel(useAssistantStore.getState().modelState)) {
			return true
		}

		queueMicrotask(() => {
			assistantInitialFocusTarget()?.focus()
		})

		return false
	}

	// No `finally`: the React Compiler cannot lower one yet and would skip this whole component.
	async function remove(): Promise<void> {
		setPending(true)

		try {
			await removeAssistantModel()
		} catch {
			toast.error(t("assistant:assistantRemoveModelFailed"))
		}

		setPending(false)
		setConfirmOpen(false)
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("assistant:assistantMoreOptions")}
							className="app-region-no-drag"
						>
							<EllipsisIcon />
						</Button>
					}
				/>
				<DropdownMenuContent
					align="end"
					className="min-w-52"
				>
					<DropdownMenuItem
						variant="destructive"
						onClick={() => {
							setConfirmOpen(true)
						}}
					>
						<Trash2Icon />
						{t("assistant:assistantRemoveModel")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmDialog
				open={confirmOpen}
				pending={pending}
				title={t("assistant:assistantRemoveModelTitle")}
				body={t("assistant:assistantRemoveModelBody", { size: formatBytes(removableModelBytes(state)) })}
				confirmLabel={t("assistant:assistantRemoveModelConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				finalFocus={focusAfterClose}
				onOpenChange={setConfirmOpen}
				onConfirm={() => {
					void remove()
				}}
			/>
		</>
	)
}

// Electron drag region like the left sidebars' headers, but only the header: the conversation below must
// stay selectable.
export function AssistantHeader({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("assistant")
	const modelState = useAssistantStore(state => state.modelState)
	const hasConversation = useAssistantStore(state => state.entries.length > 0)
	const turnActive = useAssistantStore(state => state.activeTurnId !== null)
	const historyOpen = useAssistantHistoryStore(state => state.open)
	const conversing = modelAcceptsMessages(modelState)

	return (
		<div className="flex shrink-0 items-center gap-2 p-3 app-region-drag">
			<h2
				id={ASSISTANT_TITLE_ID}
				className="truncate px-1 text-[15px] font-medium"
			>
				{t("assistantTitle")}
			</h2>
			<StatusChip
				state={modelState}
				turnActive={turnActive}
			/>
			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				{/* In every model state: saved conversations stay deletable without a model. */}
				<TooltipIconButton
					label={t("assistantHistory")}
					pressed={historyOpen}
					className="app-region-no-drag"
					onClick={() => {
						setAssistantHistoryOpen(!historyOpen)
					}}
				>
					<HistoryIcon />
				</TooltipIconButton>
				{hasConversation && conversing && !historyOpen ? (
					<TooltipIconButton
						label={t("assistantNewConversation")}
						className="app-region-no-drag"
						onClick={() => {
							// This button goes with the conversation; the composer stays.
							assistantInitialFocusTarget()?.focus()
							startNewAssistantConversation()
						}}
					>
						<SquarePenIcon />
					</TooltipIconButton>
				) : null}
				{canRemoveModel(modelState) ? <ModelMenu state={modelState} /> : null}
				<TooltipIconButton
					label={t("assistantClose")}
					className="app-region-no-drag"
					shortcut={<Kbd action="app.toggleAssistant" />}
					onClick={onClose}
				>
					<XIcon />
				</TooltipIconButton>
			</div>
		</div>
	)
}
