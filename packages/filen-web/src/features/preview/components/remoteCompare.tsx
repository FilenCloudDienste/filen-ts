import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { Extension } from "@codemirror/state"
import { codeTheme, mountCodeCompare } from "@filen/office/dom/code"
import { type DriveItem } from "@/features/drive/lib/item"
import { codeMirrorLanguageFor, decodeUtf8, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { languageExtensionFor } from "@/features/preview/lib/codeMirrorShared"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { LoadingState } from "@/components/loadingState"
import { isNarrowViewport } from "@/features/shell/lib/breakpoints"

// The newer version's text, as far as it has been had.
export type RemoteTheirs = { status: "loading" } | { status: "failed" } | { status: "ready"; text: string }

// The columns' names and the one-column legend, where the comparison is not with a newer version (View changes).
export interface CompareLabels {
	readonly theirs: string
	readonly mine: string
	readonly unified: string
}

// Read-only comparison of a newer version saved elsewhere (`theirs`) with the unsaved edits (`mine`), shown inside the remote-change
// dialog before the user picks. `tag` is the CodeMirror language (codeMirrorLanguageFor).
export function RemoteCompare({
	theirs,
	mine: mineText,
	tag,
	labels
}: {
	theirs: RemoteTheirs
	mine: string
	tag: string
	labels?: CompareLabels | undefined
}) {
	const { t } = useTranslation("preview")
	const theirsText = theirs.status === "ready" ? theirs.text : null
	// The edits as a save writes them may begin with the file's byte order mark, which theirs (decoded) does not.
	const mine = mineText.startsWith("\uFEFF") ? mineText.slice(1) : mineText
	const language = languageExtensionFor(tag)
	const hostRef = useRef<HTMLDivElement>(null)
	// Side by side needs the width; a narrow window gets one column with both versions interleaved.
	const [sideBySide] = useState(() => !isNarrowViewport())

	useEffect(() => {
		const host = hostRef.current

		if (host === null || theirsText === null) {
			return undefined
		}

		const extensions: Extension = language === null ? codeTheme : [codeTheme, language]

		return mountCodeCompare({ parent: host, theirs: theirsText, mine, sideBySide, extensions })
	}, [theirsText, mine, language, sideBySide])

	if (theirs.status === "failed") {
		return <p className="flex items-center justify-center text-sm text-destructive">{t("previewRemoteCompareFailed")}</p>
	}

	if (theirsText === null) {
		return <LoadingState size="lg" />
	}

	return (
		<div className="flex min-h-0 flex-col gap-2">
			{sideBySide ? (
				<div className="grid shrink-0 grid-cols-2 gap-px text-xs font-medium text-muted-foreground">
					<span>{labels?.theirs ?? t("previewRemoteTheirs")}</span>
					<span className="pl-3">{labels?.mine ?? t("previewRemoteMine")}</span>
				</div>
			) : (
				<p className="shrink-0 text-xs text-muted-foreground">{labels?.unified ?? t("previewRemoteUnifiedLegend")}</p>
			)}
			<div
				ref={hostRef}
				className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 text-[13px] [&_.cm-mergeView]:min-h-full"
			/>
		</div>
	)
}

// A file's newer version, downloaded here (from the preview cache when it was opened already).
export function RemoteFileCompare({ theirs, mine }: { theirs: DriveItem; mine: string }) {
	const result = usePreviewBytes(theirs)

	return (
		<RemoteCompare
			theirs={
				result.status === "success"
					? { status: "ready", text: decodeUtf8(result.bytes) }
					: { status: result.status === "error" ? "failed" : "loading" }
			}
			mine={mine}
			tag={codeMirrorLanguageFor(itemTypeExtension(theirs))}
		/>
	)
}
