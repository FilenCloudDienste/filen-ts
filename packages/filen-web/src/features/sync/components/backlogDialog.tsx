import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { DesktopSyncBacklog } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"

const OPTIONS: readonly {
	value: DesktopSyncBacklog
	title: "backlogPropagate" | "backlogAdoptDestination"
	description: "backlogPropagateDescription" | "backlogAdoptDestinationDescription"
}[] = [
	{ value: "propagate", title: "backlogPropagate", description: "backlogPropagateDescription" },
	{ value: "adoptDestination", title: "backlogAdoptDestination", description: "backlogAdoptDestinationDescription" }
]

// Leaving a backup mode: what happens to the changes the backup kept from its destination. Nothing is preselected,
// so the choice is always the user's.
export function BacklogDialog({
	pending,
	onConfirm,
	onClose
}: {
	pending: boolean
	onConfirm: (backlog: DesktopSyncBacklog) => void
	onClose: () => void
}) {
	const { t } = useTranslation(["sync", "common"])
	const id = useId()
	const [backlog, setBacklog] = useState<DesktopSyncBacklog | null>(null)

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			onClose()
		}
	})

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent closeButtonDisabled={pending}>
				<DialogHeader>
					<DialogTitle>{t("backlogTitle")}</DialogTitle>
					<DialogDescription>{t("backlogDescription")}</DialogDescription>
				</DialogHeader>
				<RadioGroup
					aria-label={t("backlogTitle")}
					name={`${id}-backlog`}
					value={backlog}
					disabled={pending}
					className="flex flex-col gap-1"
					onValueChange={(next: unknown) => {
						const option = OPTIONS.find(candidate => candidate.value === next)

						if (option !== undefined) {
							setBacklog(option.value)
						}
					}}
				>
					{OPTIONS.map(option => (
						<label
							key={option.value}
							htmlFor={`${id}-${option.value}`}
							className={cn(
								"flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/60",
								backlog === option.value && "bg-muted"
							)}
						>
							<RadioGroupItem
								id={`${id}-${option.value}`}
								value={option.value}
								className="mt-0.5"
							/>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm font-medium">{t(option.title)}</span>
								<span className="text-sm text-muted-foreground">{t(option.description)}</span>
							</span>
						</label>
					))}
				</RadioGroup>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={pending}
						onClick={onClose}
					>
						{t("common:cancel")}
					</Button>
					<Button
						disabled={pending || backlog === null}
						onClick={() => {
							if (backlog !== null) {
								onConfirm(backlog)
							}
						}}
					>
						{pending ? <Spinner data-icon="inline-start" /> : null}
						{t("backlogConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
