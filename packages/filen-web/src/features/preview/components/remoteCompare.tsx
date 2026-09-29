import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { MergeView, unifiedMergeView } from "@codemirror/merge"
import { type DriveItem } from "@/features/drive/lib/item"
import { codeMirrorLanguageFor, decodeUtf8, extensionOf } from "@/features/drive/lib/preview.logic"
import { useCodeMirrorTheme, useLanguageExtension } from "@/features/preview/lib/codeMirrorShared"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { LoadingState } from "@/components/loadingState"
import { isNarrowViewport } from "@/features/shell/lib/breakpoints"

// Unchanged stretches fold away so the differences stay in view, and a diff that runs long falls back
// to a coarser one rather than holding the main thread on two large, very different files.
const COLLAPSE_UNCHANGED = { margin: 3, minSize: 4 }
const DIFF_CONFIG = { scanLimit: 10_000, timeout: 500 }

// The newer version's text, as far as it has been had.
export type RemoteTheirs = { status: "loading" } | { status: "failed" } | { status: "ready"; text: string }

// Read-only comparison of a newer version saved elsewhere (`theirs`) with the unsaved edits (`mine`), shown inside the remote-change
// dialog before the user picks. `tag` is the CodeMirror language (codeMirrorLanguageFor). Its own chunk,
// with @codemirror/merge, as most conflicts are settled without it.
export function RemoteCompare({ theirs, mine, tag }: { theirs: RemoteTheirs; mine: string; tag: string }) {
	const { t } = useTranslation("preview")
	const theirsText = theirs.status === "ready" ? theirs.text : null
	const theme = useCodeMirrorTheme()
	const language = useLanguageExtension(tag)
	const hostRef = useRef<HTMLDivElement>(null)
	// Side by side needs the width; a narrow window gets one column with both versions interleaved.
	const [sideBySide] = useState(() => !isNarrowViewport())

	useEffect(() => {
		const host = hostRef.current

		if (host === null || theirsText === null) {
			return undefined
		}

		const extensions: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, theme]

		if (language !== null) {
			extensions.push(language)
		}

		if (sideBySide) {
			const view = new MergeView({
				a: { doc: theirsText, extensions },
				b: { doc: mine, extensions },
				parent: host,
				gutter: true,
				collapseUnchanged: COLLAPSE_UNCHANGED,
				diffConfig: DIFF_CONFIG
			})

			return () => {
				view.destroy()
			}
		}

		const view = new EditorView({
			doc: mine,
			extensions: [
				...extensions,
				unifiedMergeView({
					original: theirsText,
					mergeControls: false,
					gutter: true,
					collapseUnchanged: COLLAPSE_UNCHANGED,
					diffConfig: DIFF_CONFIG
				})
			],
			parent: host
		})

		return () => {
			view.destroy()
		}
	}, [theirsText, mine, theme, language, sideBySide])

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
					<span>{t("previewRemoteTheirs")}</span>
					<span className="pl-3">{t("previewRemoteMine")}</span>
				</div>
			) : (
				<p className="shrink-0 text-xs text-muted-foreground">{t("previewRemoteUnifiedLegend")}</p>
			)}
			<div
				ref={hostRef}
				className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 text-[13px] [&_.cm-mergeView]:min-h-full"
			/>
		</div>
	)
}

// A file's newer version, downloaded here (from the preview cache when it was opened already).
export function RemoteFileCompare({ theirs, mine, name }: { theirs: DriveItem; mine: string; name: string }) {
	const result = usePreviewBytes(theirs)

	return (
		<RemoteCompare
			theirs={
				result.status === "success"
					? { status: "ready", text: decodeUtf8(result.bytes) }
					: { status: result.status === "error" ? "failed" : "loading" }
			}
			mine={mine}
			tag={codeMirrorLanguageFor(extensionOf(name))}
		/>
	)
}

export default RemoteFileCompare
