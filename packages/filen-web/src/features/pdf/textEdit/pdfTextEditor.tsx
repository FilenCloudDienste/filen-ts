import { useRef, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { InfoIcon } from "lucide-react"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import {
	cssColor,
	editorFontFamily,
	editorKey,
	editorPlacement,
	textRows,
	type TextEditorSource
} from "@/features/pdf/textEdit/textEdit.logic"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"

// The in-place editor over a PDF text block (or where new text goes): a dashed box with the text in its size, colour
// and the font it will be set in, and above it the font chip "Aa <font> (substitute) ⓘ" and Done. Escape cancels,
// Mod+Enter or Done applies; keys of an input method's composition do neither. Positioned in the page surface's CSS
// px (the parent is the page box, position: relative). The text is read on Done, never held in React state.

export interface PdfTextEditorProps {
	source: TextEditorSource
	// CSS px per PDF point at the page's current zoom.
	scale: number
	// The edit is being applied: Done shows progress, the text is read-only.
	busy?: boolean
	onDone: (text: string) => void
	onCancel: () => void
}

const IS_MAC = isMacPlatform()

export function PdfTextEditor({ source, scale, busy, onDone, onCancel }: PdfTextEditorProps) {
	const { t } = useTranslation("preview")
	const field = useRef<HTMLTextAreaElement>(null)
	const compositionEndedAt = useRef(Number.NEGATIVE_INFINITY)
	const placement = editorPlacement(source, scale)
	const font = source.font
	const applying = busy === true

	const finish = (): void => {
		if (applying || field.current === null) return

		onDone(field.current.value)
	}

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		const action = editorKey(
			{
				key: event.key,
				metaKey: event.metaKey,
				ctrlKey: event.ctrlKey,
				altKey: event.altKey,
				shiftKey: event.shiftKey,
				isComposing: event.nativeEvent.isComposing,
				sinceCompositionEnd: event.timeStamp - compositionEndedAt.current
			},
			IS_MAC
		)

		if (action === null) return

		// The viewer's own keys (Escape closes the preview) never see a key the editor used.
		event.preventDefault()
		event.stopPropagation()

		if (action === "cancel") onCancel()
		else finish()
	}

	return (
		<div
			data-slot="pdf-text-editor"
			className="absolute z-20"
			style={{
				left: placement.left,
				top: placement.top,
				transform: placement.angle === 0 ? undefined : `rotate(${String(placement.angle)}deg)`,
				transformOrigin: "0 0"
			}}
		>
			<div className="absolute bottom-full left-0 mb-1 flex items-center gap-1 rounded-full border bg-popover px-2 py-0.5 text-xs whitespace-nowrap text-popover-foreground shadow-sm">
				<span>
					{t("previewPdfTextEditFontChip", { font: font.label })}
					{font.substitute ? ` ${t("previewPdfTextEditSubstituteMark")}` : null}
				</span>
				{font.substitute ? (
					<Popover>
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("previewPdfTextEditFontInfo")}
								/>
							}
						>
							<InfoIcon aria-hidden="true" />
						</PopoverTrigger>
						<PopoverContent
							side="top"
							className="text-xs"
						>
							{t("previewPdfTextEditSubstitute", { font: font.label })}
						</PopoverContent>
					</Popover>
				) : null}
				<Button
					size="xs"
					disabled={applying}
					onClick={finish}
				>
					{applying ? (
						<>
							<Spinner
								aria-hidden="true"
								className="size-3"
							/>
							{t("previewPdfTextEditApplying")}
						</>
					) : (
						t("previewPdfTextEditDone")
					)}
				</Button>
			</div>
			<textarea
				ref={field}
				aria-label={t("previewPdfTextEditField")}
				defaultValue={source.text}
				rows={textRows(source.text)}
				readOnly={applying}
				dir="auto"
				spellCheck
				autoFocus
				onKeyDown={onKeyDown}
				onCompositionEnd={event => {
					compositionEndedAt.current = event.timeStamp
				}}
				onInput={event => {
					event.currentTarget.rows = textRows(event.currentTarget.value)
				}}
				onFocus={event => {
					const end = event.currentTarget.value.length

					event.currentTarget.setSelectionRange(end, end)
				}}
				className="block resize-none overflow-hidden border border-dashed border-primary bg-background/80 p-0 outline-none"
				style={{
					width: placement.width,
					minHeight: placement.height,
					fontSize: placement.fontSize,
					lineHeight: `${String(placement.lineHeight)}px`,
					color: cssColor(source.color),
					fontFamily: editorFontFamily(font.family, font.label),
					fontWeight: font.bold ? 700 : 400,
					fontStyle: font.italic ? "italic" : "normal"
				}}
			/>
		</div>
	)
}
