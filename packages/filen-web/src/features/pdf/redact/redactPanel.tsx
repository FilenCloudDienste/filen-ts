import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { RedactionFailure, RedactionFinding, RedactionMark } from "@filen/office/core/pdfedit/redactVerify"
import { usePdfEditSession } from "@filen/office/react/pdfedit"
import { ApplyRedactionsDialog, type ApplyRedactionsOptions } from "@/features/pdf/redact/applyRedactionsDialog"
import { FindRedactPanel } from "@/features/pdf/redact/findRedactPanel"
import { applyRedactions, rememberSearch } from "@/features/pdf/redact/redactFlow"
import { RedactionMarksList } from "@/features/pdf/redact/redactionMarksList"
import type { RedactMode } from "@/features/pdf/redact/redaction.logic"
import { useToolSession } from "@/features/pdf/session/useToolSession"
import type { PdfToolPanelProps } from "@/features/pdf/tools/registry"

// The Redact tools' side panel: Find & redact (its mode), the marks waiting to be applied, and Apply redactions…,
// which applies every mark, saves the result (a copy "name (redacted).pdf" by default) and has it verified before
// anything is uploaded. A copy leaves this file as it was saved; a new version shows the earlier-versions warning.

interface RedactPanelProps extends PdfToolPanelProps {
	readonly mode: RedactMode
}

// The panel of each Redact tool.
export function RedactAreaPanel(props: PdfToolPanelProps) {
	return (
		<RedactPanel
			{...props}
			mode="area"
		/>
	)
}

export function RedactTextPanel(props: PdfToolPanelProps) {
	return (
		<RedactPanel
			{...props}
			mode="text"
		/>
	)
}

export function RedactFindPanel(props: PdfToolPanelProps) {
	return (
		<RedactPanel
			{...props}
			mode="find"
		/>
	)
}

function RedactPanel({ context, mode }: RedactPanelProps) {
	const { t } = useTranslation("preview")
	const { session, stale } = useToolSession(context)
	const snapshot = usePdfEditSession(session)
	const revision = snapshot?.state.revision ?? -1
	const [marks, setMarks] = useState<readonly RedactionMark[]>([])
	const [findings, setFindings] = useState<readonly RedactionFinding[] | null>(null)
	const [searching, setSearching] = useState(false)
	const [open, setOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<RedactionFailure | null>(null)
	const [taken, setTaken] = useState<ReadonlySet<string>>(new Set())
	const lost = useEffectEvent(() => {
		stale()
	})

	// The marks, read again after every change (undo and redo included).
	useEffect(() => {
		if (session === null || revision < 0) return

		let live = true

		void session.engine.call("redactMarks", {}).then(
			read => {
				if (live) setMarks(read)
			},
			() => {
				if (live) lost()
			}
		)

		return () => {
			live = false
		}
	}, [session, revision])

	const apply = (options: ApplyRedactionsOptions): void => {
		setBusy(true)
		setFailure(null)
		void applyRedactions(context, {
			...options,
			copySuffix: number => (number <= 1 ? t("previewPdfRedactCopySuffix") : t("previewPdfRedactCopySuffixNumbered", { number }))
		}).then(outcome => {
			setBusy(false)

			switch (outcome.kind) {
				case "saved":
					setOpen(false)

					if (outcome.copy === null) toast.success(t("previewPdfRedactSaved"))
					else {
						toast.success(t("previewPdfRedactSavedCopy", { name: outcome.copy }))
						// The copy holds the redaction: this file goes back to how it was saved.
						context.host.close()
					}

					context.finish()
					break
				case "refused":
					setFailure(outcome.failure)
					break
				case "failed":
					toast.error(t("previewPdfRedactSaveFailed"))
					break
				case "cancelled":
					break
			}
		})
	}

	return (
		<aside className="flex h-full w-80 shrink-0 flex-col border-l bg-background">
			{mode === "find" ? (
				<div className="min-h-0 flex-1 border-b">
					<FindRedactPanel
						findings={findings}
						searching={searching}
						onSearch={query => {
							setSearching(true)
							context.edit(
								async current => {
									const found = await current.engine.call("redactFind", { query }).catch(() => [])

									rememberSearch(current, query)
									setFindings(found)
									setSearching(false)
								},
								() => {
									setSearching(false)
								}
							)
						}}
						onMark={chosen => {
							context.edit(current =>
								current.dispatch("redact.markFindings", {
									findings: chosen.map(finding => ({ page: finding.page, quads: finding.quads }))
								})
							)
							setFindings(null)
						}}
						onClose={() => {
							context.finish()
						}}
					/>
				</div>
			) : null}
			<div className="min-h-0 flex-1">
				<RedactionMarksList
					marks={marks}
					disabled={busy}
					onRemove={mark => {
						context.edit(current => current.dispatch("redact.removeMark", { page: mark.page, id: mark.id }))
					}}
					onApply={() => {
						setFailure(null)
						setOpen(true)
						void context.host.takenNames().then(setTaken, () => undefined)
					}}
				/>
			</div>
			<ApplyRedactionsDialog
				open={open}
				onOpenChange={setOpen}
				fileName={context.host.fileName}
				takenNames={taken}
				canSaveInPlace={context.host.canSaveInPlace}
				busy={busy}
				failure={failure}
				onApply={apply}
			/>
		</aside>
	)
}
