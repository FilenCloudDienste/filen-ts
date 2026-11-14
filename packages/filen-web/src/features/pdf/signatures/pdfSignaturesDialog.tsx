import { useTranslation } from "react-i18next"
import type { PdfCertificateInfo, PdfSignatureInfo, PdfSignatureReport } from "@filen/office/core/pdfsign"
import { CHANGE_KIND_KEYS, certificationKey, reasonKey, signerName, stateKey } from "@/features/pdf/signatures/signatureStatus.logic"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatDateTime, formatShortDate } from "@/lib/formatDate"

// Every signature of a document with what was checked and what was not: its state, the changes after it, the times
// (the signer's claim, never trusted; an embedded timestamp, whose authority is not verified) and the certificates as
// the signature carries them.

export interface PdfSignaturesDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	report: PdfSignatureReport
	onViewSignedVersion?: ((byteLength: number) => void) | undefined
}

export function PdfSignaturesDialog({ open, onOpenChange, report, onViewSignedVersion }: PdfSignaturesDialogProps) {
	const { t } = useTranslation("preview")

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent
				data-preview-surface
				className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
			>
				<DialogHeader>
					<DialogTitle>{t("previewPdfSignaturesTitle")}</DialogTitle>
					<DialogDescription>{t("previewPdfSignatureSignerNotVerified")}</DialogDescription>
				</DialogHeader>
				<ol className="flex flex-col gap-4">
					{report.signatures.map(signature => (
						<SignatureEntry
							key={`${signature.field}-${String(signature.signedLength)}`}
							signature={signature}
							revisions={report.revisions}
							onViewSignedVersion={
								onViewSignedVersion === undefined
									? undefined
									: () => {
											onOpenChange(false)
											onViewSignedVersion(signature.signedLength)
										}
							}
						/>
					))}
				</ol>
				{report.dss ? <p className="text-xs text-muted-foreground">{t("previewPdfSignatureDss")}</p> : null}
			</DialogContent>
		</Dialog>
	)
}

function SignatureEntry({
	signature,
	revisions,
	onViewSignedVersion
}: {
	signature: PdfSignatureInfo
	revisions: number
	onViewSignedVersion: (() => void) | undefined
}) {
	const { t } = useTranslation("preview")
	const reason = reasonKey(signature)
	const certification = certificationKey(signature.certification)
	const name = signerName(signature)
	const kinds = signature.changes?.kinds.map(kind => t(CHANGE_KIND_KEYS[kind])).join(", ") ?? ""
	const changes =
		signature.changes === null
			? null
			: signature.changes.kinds.length === 0
				? t("previewPdfSignatureChangesNone")
				: t(signature.changes.allowed ? "previewPdfSignatureChangesAllowed" : "previewPdfSignatureChangesNotAllowed", { kinds })

	return (
		<li
			className="flex flex-col gap-2 rounded-lg border p-3"
			data-state={signature.state}
		>
			<div className="flex flex-col gap-0.5">
				<p className="font-medium">
					{signature.kind === "timestamp" ? `${t("previewPdfSignatureDocumentTimestamp")} · ` : ""}
					{name ?? t("previewPdfSignatureUnknownSigner")}
				</p>
				<p className="text-xs">
					{t(stateKey(signature))}
					{reason === null ? "" : ` · ${t(reason)}`}
				</p>
				{changes === null ? null : <p className="text-xs">{changes}</p>}
				{certification === null ? null : <p className="text-xs">{t(certification)}</p>}
			</div>
			<ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
				{signature.claimedTime === null ? null : (
					<li>{t("previewPdfSignatureClaimedTime", { time: formatDateTime(signature.claimedTime) })}</li>
				)}
				<li>
					{signature.timestampTime === null
						? t("previewPdfSignatureNoTimestamp")
						: t("previewPdfSignatureTimestamped", { time: formatDateTime(signature.timestampTime) })}
				</li>
				{signature.expiredAtClaimedTime ? <li>{t("previewPdfSignatureExpired")}</li> : null}
				{signature.notYetValidAtClaimedTime ? <li>{t("previewPdfSignatureNotYetValid")}</li> : null}
				{signature.signer?.selfSigned === true ? <li>{t("previewPdfSignatureSelfSigned")}</li> : null}
			</ul>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
				<Row
					label={t("previewPdfSignatureField")}
					value={signature.field}
				/>
				<Row
					label={t("previewPdfSignaturePage")}
					value={signature.page === null ? null : String(signature.page + 1)}
				/>
				<Row
					label={t("previewPdfSignatureRevision")}
					value={
						signature.revision === 0
							? null
							: t("previewPdfSignatureRevisionOf", { revision: signature.revision, total: revisions })
					}
				/>
				<Row
					label={t("previewPdfSignatureName")}
					value={signature.name}
				/>
				<Row
					label={t("previewPdfSignatureReason")}
					value={signature.reason}
				/>
				<Row
					label={t("previewPdfSignatureLocation")}
					value={signature.location}
				/>
				<Row
					label={t("previewPdfSignatureContact")}
					value={signature.contactInfo}
				/>
				<Row
					label={t("previewPdfSignatureAlgorithm")}
					value={
						signature.algorithm === null
							? null
							: signature.digest === null
								? signature.algorithm
								: t("previewPdfSignatureAlgorithmWith", { algorithm: signature.algorithm, digest: signature.digest })
					}
				/>
				{signature.signer === null ? null : <CertificateRows certificate={signature.signer} />}
				<Row
					label={t("previewPdfSignatureChain")}
					value={signature.chain.length === 0 ? null : signature.chain.map(cert => cert.commonName ?? cert.subject).join(" → ")}
				/>
			</dl>
			{onViewSignedVersion !== undefined && signature.state === "changed" ? (
				<Button
					variant="outline"
					size="xs"
					className="self-start"
					onClick={onViewSignedVersion}
				>
					{t("previewPdfSignatureViewSigned")}
				</Button>
			) : null}
		</li>
	)
}

function CertificateRows({ certificate }: { certificate: PdfCertificateInfo }) {
	const { t } = useTranslation("preview")

	return (
		<>
			<Row
				label={t("previewPdfSignatureSubject")}
				value={certificate.subject}
			/>
			<Row
				label={t("previewPdfSignatureIssuer")}
				value={certificate.issuer}
			/>
			<Row
				label={t("previewPdfSignatureSerial")}
				value={certificate.serial}
			/>
			<Row
				label={t("previewPdfSignatureValidity")}
				value={t("previewPdfSignatureValidityRange", {
					from: formatShortDate(certificate.notBefore),
					until: formatShortDate(certificate.notAfter)
				})}
			/>
		</>
	)
}

function Row({ label, value }: { label: string; value: string | null }) {
	const { t } = useTranslation("preview")

	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{value ?? t("previewPdfSignatureNone")}</dd>
		</>
	)
}
