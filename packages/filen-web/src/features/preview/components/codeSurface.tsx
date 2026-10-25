import { useEffect, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { isCodeLanguageId, type CodeLanguageId } from "@filen/office/core/code"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { CodeCommandBar, type MarkdownBar } from "@/features/preview/components/codeCommandBar"
import { RemoteCompare } from "@/features/preview/components/remoteCompare"
import { onCommandBarF6 } from "@/features/office/components/ribbon/ribbonFocus"
import { CodeChrome, detectIndent, type CodeIndent } from "@/features/preview/lib/codeChrome"
import { useCodeViewSettings } from "@/features/preview/lib/codeViewSettings"
import { usePreviewDownload } from "@/features/preview/lib/accessMode"
import type { TextFile } from "@/features/preview/lib/textFile"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// A text file in the editor under its command bar (codeCommandBar.tsx): the text and code viewers', and the markdown
// viewer's source. The editor's switchable parts, find and status live in one CodeChrome for the editor's life.

export interface CodeSurfaceProps {
	file: TextFile
	tag: string
	alt: string
	editable: boolean
	locked: boolean
	onDirtyChange?: ((dirty: boolean) => void) | undefined
	contentRef?: RefObject<(() => string) | null> | undefined
	autoFocus?: boolean | undefined
	// The markdown source's view switch and formatting.
	markdown?: MarkdownBar | undefined
}

// Find opens for keys pressed in the layer the file is shown in (the preview overlay), never one over it.
const LAYER = "[role='dialog'], [role='alertdialog']"

// "12" or "12:5" (line, column), within the file.
function parseLine(value: string, lines: number): { line: number; column: number } | null {
	const match = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(value)
	const line = match === null ? Number.NaN : Number(match[1])

	if (match === null || !Number.isInteger(line) || line < 1 || line > lines) {
		return null
	}

	return { line, column: match[2] === undefined ? 1 : Number(match[2]) }
}

export function CodeSurface({ file, tag, alt, editable, locked, onDirtyChange, contentRef, autoFocus, markdown }: CodeSurfaceProps) {
	const { t } = useTranslation("preview")
	const settings = useCodeViewSettings()
	const [language, setLanguage] = useState<CodeLanguageId | "">(() => (isCodeLanguageId(tag) ? tag : ""))
	const [indent, setIndent] = useState<CodeIndent>(() => detectIndent(file.text))
	const [chrome] = useState(() => new CodeChrome({ settings, language, indent, editable }))
	const [dirty, setDirty] = useState(false)
	const [goToLine, setGoToLine] = useState(false)
	// The edits being compared with the file as opened, while View changes is open.
	const [changes, setChanges] = useState<string | null>(null)
	const download = usePreviewDownload()
	const rootRef = useRef<HTMLDivElement | null>(null)

	// Find with focus on the bar or beside the editor; in the editor its own keymap answered already.
	useAction(
		"editor.find",
		keyboardEvent => {
			const root = rootRef.current

			if (root === null || keyboardEvent.defaultPrevented) {
				return
			}

			const layer = root.closest(LAYER)
			const target = keyboardEvent.target instanceof Element ? keyboardEvent.target.closest(LAYER) : null

			if (target !== layer || (layer === null && isAnyDialogOpen())) {
				return
			}

			keyboardEvent.preventDefault()
			chrome.find.open(false)
		},
		IN_EDITORS,
		[chrome]
	)

	useEffect(() => {
		return () => {
			chrome.dispose()
		}
	}, [chrome])

	useEffect(() => {
		return chrome.onGoToLine(() => {
			setGoToLine(true)
		})
	}, [chrome])

	// Passed on from here, not from a wrapper around the editor's callback: a new wrapper would make the editor report
	// its dirty bit again, over a save that has just reset it.
	useEffect(() => {
		onDirtyChange?.(dirty)
	}, [dirty, onDirtyChange])

	useEffect(() => {
		chrome.setWrap(settings.wrap)
	}, [chrome, settings.wrap])

	useEffect(() => {
		chrome.setLineNumbers(settings.lineNumbers)
	}, [chrome, settings.lineNumbers])

	useEffect(() => {
		chrome.remeasure()
	}, [chrome, settings.fontSize])

	return (
		<div
			ref={rootRef}
			className="flex size-full flex-col"
			onKeyDown={event => {
				onCommandBarF6(event, () => {
					chrome.focus()
				})
			}}
		>
			<CodeCommandBar
				chrome={chrome}
				editable={editable}
				locked={locked}
				dirty={dirty}
				markdown={markdown ?? null}
				language={language}
				onLanguage={next => {
					setLanguage(next)
					chrome.setLanguage(next)
				}}
				indent={indent}
				onIndent={next => {
					setIndent(next)
					chrome.setIndent(next)
				}}
				settings={settings}
				format={file}
				onGoToLine={() => {
					setGoToLine(true)
				}}
				onViewChanges={() => {
					setChanges(chrome.text())
				}}
				onDownload={download}
			/>
			{/* The font size is CSS only: the editor inherits it, nothing is reconfigured. */}
			<div
				className="min-h-0 flex-1"
				style={{ fontSize: `${String(settings.fontSize)}px` }}
			>
				<CodeMirrorSource
					text={file.text}
					tag={tag}
					alt={alt}
					editable={editable}
					locked={locked}
					autoFocus={autoFocus ?? false}
					chrome={chrome}
					format={file}
					onDirtyChange={setDirty}
					// exactOptionalPropertyTypes: an unset optional prop must omit the key entirely.
					{...(contentRef !== undefined ? { contentRef } : {})}
				/>
			</div>
			<InputDialog
				open={goToLine}
				pending={false}
				title={t("previewCommandBarGoToLine")}
				body={t("previewCommandBarGoToLineLabel", { total: chrome.lineCount() })}
				label={t("previewCommandBarGoToLine")}
				inputMode="numeric"
				submitLabel={t("previewCommandBarGoToLineSubmit")}
				validate={value => parseLine(value, chrome.lineCount()) !== null}
				onOpenChange={setGoToLine}
				onSubmit={value => {
					const target = parseLine(value, chrome.lineCount())

					setGoToLine(false)

					if (target !== null) {
						chrome.goToLine(target.line, target.column)
					}
				}}
			/>
			<Dialog
				open={changes !== null}
				onOpenChange={open => {
					if (!open) {
						setChanges(null)
					}
				}}
			>
				<DialogContent
					data-preview-surface
					className="h-[min(85vh,52rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-6xl"
				>
					<DialogHeader>
						<DialogTitle>{t("previewCommandBarViewChanges")}</DialogTitle>
					</DialogHeader>
					{changes === null ? null : (
						<RemoteCompare
							theirs={{ status: "ready", text: file.text }}
							mine={changes}
							tag={language}
							labels={{
								theirs: t("previewCommandBarChangesOpened"),
								mine: t("previewCommandBarChangesEdited"),
								unified: t("previewCommandBarChangesLegend")
							}}
						/>
					)}
				</DialogContent>
			</Dialog>
		</div>
	)
}
