import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ShieldAlertIcon, ShieldCheckIcon, ShieldQuestionIcon, ShieldXIcon, type LucideIcon } from "lucide-react"
import type { PdfSignatureSource } from "@filen/office/dom/pdf"
import type { PdfSignatureSummaryState } from "@filen/office/core/pdfsign/summary"
import { signatureBanner } from "@/features/pdf/signatures/signatureStatus.logic"
import { usePdfSignatureReport } from "@/features/pdf/signatures/usePdfSignatureReport"
import type { PdfSignatureVerify } from "@/features/pdf/signatures/useSignatureVerifier"
import { PdfSignaturesDialog } from "@/features/pdf/signatures/pdfSignaturesDialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// The one line under the command bar about a signed PDF's signatures: the most serious state among them, with
// Details (the Signatures dialog) and, for a signature followed by later changes, View signed version. Shows
// nothing for an unsigned document.

export interface PdfSignatureStatusProps {
	// What its signatures are read from (pdf.js, a second parser to the verifier's).
	document: PdfSignatureSource
	// Null: nothing can verify this document's bytes, so no status shows.
	verify: PdfSignatureVerify | null
	// Opens the byte prefix the signature covers, read-only; absent where the viewer cannot show it.
	onViewSignedVersion?: (byteLength: number) => void
}

const ICONS: Readonly<Record<PdfSignatureSummaryState, LucideIcon>> = {
	unchanged: ShieldCheckIcon,
	changedAllowed: ShieldCheckIcon,
	changedNotAllowed: ShieldAlertIcon,
	invalid: ShieldXIcon,
	unverifiable: ShieldQuestionIcon
}

const LINE = "flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"

export function PdfSignatureStatus({ document, verify, onViewSignedVersion }: PdfSignatureStatusProps) {
	const { t } = useTranslation("preview")
	const { check, retry } = usePdfSignatureReport(document, verify)
	const [details, setDetails] = useState(false)

	if (check.status === "none") {
		return null
	}

	if (check.status === "checking") {
		return (
			<div
				role="status"
				className={LINE}
			>
				<Spinner
					aria-hidden="true"
					className="size-3.5 shrink-0"
				/>
				<p className="min-w-0 flex-1">{t("previewPdfSignatureChecking")}</p>
			</div>
		)
	}

	if (check.status === "failed") {
		return (
			<div
				role="status"
				className={LINE}
			>
				<ShieldQuestionIcon
					aria-hidden="true"
					className="size-3.5 shrink-0"
				/>
				<p className="min-w-0 flex-1">{t("previewPdfSignatureCheckFailed")}</p>
				<Button
					variant="outline"
					size="xs"
					onClick={retry}
				>
					{t("previewPdfSignatureRetry")}
				</Button>
			</div>
		)
	}

	const banner = signatureBanner(check.report)

	if (banner === null) {
		return null
	}

	const Icon = ICONS[banner.state]
	const signedLength = banner.signedLength

	return (
		<div
			role="status"
			data-state={banner.state}
			className={LINE}
		>
			<Icon
				aria-hidden="true"
				className="size-3.5 shrink-0"
			/>
			<p className="min-w-0 flex-1 truncate">
				{t(banner.key, {
					name: banner.name ?? t("previewPdfSignatureUnknownSigner"),
					reason: banner.reason === null ? "" : t(banner.reason)
				})}
			</p>
			{signedLength !== null && onViewSignedVersion !== undefined ? (
				<Button
					variant="outline"
					size="xs"
					onClick={() => {
						onViewSignedVersion(signedLength)
					}}
				>
					{t("previewPdfSignatureViewSigned")}
				</Button>
			) : null}
			<Button
				variant="outline"
				size="xs"
				onClick={() => {
					setDetails(true)
				}}
			>
				{t("previewPdfSignatureDetails")}
			</Button>
			<PdfSignaturesDialog
				open={details}
				onOpenChange={setDetails}
				report={check.report}
				onViewSignedVersion={onViewSignedVersion}
			/>
		</div>
	)
}

// The status line shown above the signed version of a document, instead of the signatures' own.
export function PdfSignedVersionStatus({ onBack }: { onBack: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<div
			role="status"
			className={LINE}
		>
			<ShieldCheckIcon
				aria-hidden="true"
				className="size-3.5 shrink-0"
			/>
			<p className="min-w-0 flex-1">{t("previewPdfSignatureViewingSigned")}</p>
			<Button
				variant="outline"
				size="xs"
				onClick={onBack}
			>
				{t("previewPdfSignatureViewCurrent")}
			</Button>
		</div>
	)
}
