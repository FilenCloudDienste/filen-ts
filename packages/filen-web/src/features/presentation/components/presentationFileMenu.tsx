import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { PresentationDownloadAsEntries } from "@/features/presentation/components/fileMenu/downloadAs"
import { PresentationExportEntries } from "@/features/presentation/components/fileMenu/export"
import {
	PresentationAutosaveEntry,
	PresentationSaveEntries,
	type PresentationFileMenuContext
} from "@/features/presentation/components/fileMenu/save"
import { PresentationTemplatesEntries } from "@/features/presentation/components/fileMenu/templates"

// The presentation editor's File menu, first in the ribbon: New from a template, Save and Download, Download as,
// Export and Print, then the autosave setting. Each run of entries is one owner's file (fileMenu/*); a run that offers
// nothing takes no room, and a line parts the runs that do.

const ENTRIES = [
	["templates", PresentationTemplatesEntries],
	["save", PresentationSaveEntries],
	["downloadAs", PresentationDownloadAsEntries],
	["export", PresentationExportEntries],
	["autosave", PresentationAutosaveEntry]
] as const

export function PresentationFileMenu({ context }: { context: Omit<PresentationFileMenuContext, "close"> }) {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)
	const entryContext: PresentationFileMenuContext = {
		...context,
		close: () => {
			setOpen(false)
		}
	}

	return (
		<DropdownMenu
			open={open}
			onOpenChange={setOpen}
		>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("previewPptxEditorFileMenu")}
						data-ribbon-file
						className="shrink-0 gap-0.5 px-2.5"
					>
						{t("previewPptxEditorFileMenu")}
						<ChevronDownIcon className="size-3" />
					</Button>
				}
			/>
			<DropdownMenuContent
				align="start"
				data-preview-surface
				className="min-w-56 [&>[role=group]:empty]:hidden [&>[role=group]:not(:empty)~[role=group]:not(:empty)]:mt-1 [&>[role=group]:not(:empty)~[role=group]:not(:empty)]:border-t [&>[role=group]:not(:empty)~[role=group]:not(:empty)]:border-border [&>[role=group]:not(:empty)~[role=group]:not(:empty)]:pt-1"
			>
				{ENTRIES.map(([id, Entry]) => (
					<DropdownMenuGroup key={id}>
						<Entry context={entryContext} />
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
