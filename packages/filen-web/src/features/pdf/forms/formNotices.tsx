import { useEffect, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import type { PdfEditSnapshot } from "@filen/office/react/pdfedit"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import type { PdfFormSaveChoice } from "@/features/pdf/forms/formSave"

// The form's one-line notices under the ribbon: the document has form fields (with a button to the first one; until
// the first change), its scripts never run (once the editor read them), or it is an XFA-only form, which can only be
// viewed and printed. And the confirmation before a hybrid form's first save drops its XFA data.

const LINE = "flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
// Frames the first field is looked for after scrolling to the first page (it renders meanwhile).
const FOCUS_FRAMES = 30

interface FormInfo {
	readonly fields: boolean
	readonly xfa: boolean
}

function formInfo(info: unknown): FormInfo {
	const record = typeof info === "object" && info !== null ? info : {}

	return { fields: Reflect.get(record, "IsAcroFormPresent") === true, xfa: Reflect.get(record, "IsXFAPresent") === true }
}

// Focuses the first enabled field control shown, scrolling to the document's start when none is.
function focusFirstField(scroller: HTMLElement | null, frames = FOCUS_FRAMES): void {
	if (scroller === null) return

	const field = scroller.querySelector<HTMLElement>("[data-pdf-field]:not(:disabled)")

	if (field !== null) {
		field.focus()
		field.scrollIntoView({ block: "nearest", inline: "nearest" })

		return
	}

	if (frames === FOCUS_FRAMES) scroller.scrollTo({ top: 0 })
	if (frames > 0)
		requestAnimationFrame(() => {
			focusFirstField(scroller, frames - 1)
		})
}

export interface PdfFormNoticesProps {
	// The document shown (pdf.js's, or the editor's, which keeps pdf.js's information).
	readonly document: PdfDomDocument
	// The editor's snapshot once it has the document.
	readonly snapshot: PdfEditSnapshot | null
	readonly scrollerRef: RefObject<HTMLElement | null>
}

export function PdfFormNotices({ document, snapshot, scrollerRef }: PdfFormNoticesProps) {
	const { t } = useTranslation("preview")
	const [read, setRead] = useState<{ readonly document: PdfDomDocument; readonly info: FormInfo } | null>(null)
	const info = read?.document === document ? read.info : null

	useEffect(() => {
		let live = true

		void document.getMetadata().then(
			metadata => {
				if (live) setRead({ document, info: formInfo(metadata.info) })
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [document])

	const form = snapshot?.state.form ?? null
	const xfaOnly = form === null ? info !== null && info.xfa && !info.fields : form.xfa === "only"
	const fields = form === null ? info?.fields === true : form.fields > 0

	if (xfaOnly) {
		return (
			<div
				role="status"
				className={LINE}
			>
				<p className="min-w-0 flex-1">{t("previewPdfXfaOnly")}</p>
			</div>
		)
	}

	return (
		<>
			{fields && snapshot === null ? (
				<div
					role="status"
					className={LINE}
				>
					<p className="min-w-0 flex-1">{t("previewPdfFormBanner")}</p>
					<Button
						variant="outline"
						size="xs"
						onClick={() => {
							focusFirstField(scrollerRef.current)
						}}
					>
						{t("previewPdfFormBannerFocus")}
					</Button>
				</div>
			) : null}
			{form?.scripts === true ? (
				<div
					role="status"
					className={LINE}
				>
					<p className="min-w-0 flex-1">{t("previewPdfScripts")}</p>
				</div>
			) : null}
		</>
	)
}

export interface PdfXfaSaveDialogProps {
	readonly open: boolean
	readonly onAnswer: (answer: PdfFormSaveChoice) => void
}

// Before a hybrid form's first save: its XFA data goes (Save, or Save as copy keeping the original as it is), or not
// at all (Cancel, what Escape means).
export function PdfXfaSaveDialog({ open, onAnswer }: PdfXfaSaveDialogProps) {
	const { t } = useTranslation("preview")

	return (
		<AlertDialog
			open={open}
			onOpenChange={next => {
				if (!next) onAnswer("cancel")
			}}
		>
			<AlertDialogContent className="data-[size=default]:sm:max-w-xl">
				<AlertDialogHeader>
					<AlertDialogTitle>{t("previewPdfFormXfaSaveTitle")}</AlertDialogTitle>
					<AlertDialogDescription>{t("previewPdfFormXfaSaveBody")}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter className="sm:flex-wrap sm:items-center">
					<Button
						variant="ghost"
						className="sm:mr-auto"
						onClick={() => {
							onAnswer("cancel")
						}}
					>
						{t("previewPdfFormXfaSaveCancel")}
					</Button>
					<Button
						variant="outline"
						onClick={() => {
							onAnswer("copy")
						}}
					>
						{t("previewPdfSaveAsCopy")}
					</Button>
					<Button
						autoFocus
						onClick={() => {
							onAnswer("version")
						}}
					>
						{t("previewPdfFormXfaSave")}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
