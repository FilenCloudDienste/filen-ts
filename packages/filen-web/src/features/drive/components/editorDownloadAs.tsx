import { createContext, use, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { type DriveItem } from "@/features/drive/lib/item"
import { DOWNLOAD_AS_TARGETS, downloadAsTargets } from "@/features/drive/lib/downloadAs.logic"
import { startDownloadAs, type LiveConversion, type LiveFile, type LivePresentation } from "@/features/drive/lib/downloadAs"
import { usePreviewAccessMode, usePreviewCacheScope, usePreviewDownloadable } from "@/features/preview/lib/accessMode"

export type { LiveConversion, LiveFile, LivePresentation }

// Download as in the editors' File menus, after the PDF: the formats the open file converts to, made as the item
// menu makes them (lib/downloadAs.ts) from the saved file, or from the open workbook's or presentation's session where
// the viewer hands one (`live`, `livePresentation`: unsaved edits included, nothing read again). The viewer provides
// the file; offered only where it may be downloaded.

const DownloadAsItemContext = createContext<DriveItem | null>(null)

export function DownloadAsItemProvider({ item, children }: { item: DriveItem; children: ReactNode }) {
	return <DownloadAsItemContext value={item}>{children}</DownloadAsItemContext>
}

// `live`: the open workbook's own conversion, `liveFile`: the open document as its editor holds it,
// `livePresentation`: the open presentation's conversion, where the File menu hands one. `first`: nothing comes before
// them (no rule above).
export function EditorDownloadAsItems({
	live,
	liveFile,
	livePresentation,
	first = false
}: {
	live?: LiveConversion | undefined
	liveFile?: LiveFile | undefined
	livePresentation?: LivePresentation | undefined
	first?: boolean
}) {
	const { t } = useTranslation("drive")
	const item = use(DownloadAsItemContext)
	// Where the file may be downloaded (a public link's page downloads it through its own button: no host Download).
	const downloadable = usePreviewDownloadable()
	const accessMode = usePreviewAccessMode()
	const cacheScope = usePreviewCacheScope()

	if (item === null || !downloadable) {
		return null
	}

	const conversions = downloadAsTargets([item])
		.flat()
		.filter(target => target !== "pdf")

	if (conversions.length === 0) {
		return null
	}

	return (
		<>
			{first ? null : <DropdownMenuSeparator />}
			{conversions.map(target => (
				<DropdownMenuItem
					key={target}
					onClick={() => {
						void startDownloadAs([item], target, {
							accessMode,
							cacheScope,
							...(live === undefined ? {} : { live }),
							...(liveFile === undefined ? {} : { liveFile }),
							...(livePresentation === undefined ? {} : { livePresentation })
						})
					}}
				>
					{t(DOWNLOAD_AS_TARGETS[target].labelKey)}
				</DropdownMenuItem>
			))}
		</>
	)
}
