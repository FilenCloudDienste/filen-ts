import { useEffect, useId, useRef, useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { InfoIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FIELD_CONTROL_CLASS, INVALID_RING_CLASS } from "@/components/ui/surface"
import { useIsOnline } from "@/lib/useIsOnline"
import { accountQueryGet } from "@/queries/account"
import { ReportChallenge } from "@/features/publicLinks/components/reportChallenge"
import { EMPTY_REPORT_SUBJECT, useReportSubjectRef } from "@/features/publicLinks/lib/reportSubject"
import { submitAbuseReport } from "@/features/publicLinks/lib/report"
import {
	buildAbuseReport,
	canSendReport,
	hasReportPassword,
	isReportReason,
	REPORT_COMMENT_MAX_LENGTH,
	REPORT_REASONS,
	type ReportError,
	type ReportForm,
	type ReportReason,
	type ReportSubject
} from "@/features/publicLinks/lib/report.logic"

const REASON_LABEL_KEYS = {
	copyright: "reportReasonCopyright",
	stolen: "reportReasonStolen",
	malware: "reportReasonMalware",
	csam: "reportReasonCsam",
	spam: "reportReasonSpam",
	other: "reportReasonOther"
} as const satisfies Record<ReportReason, string>

const ERROR_LABEL_KEYS = {
	invalid: "reportErrorInvalid",
	turnstile: "reportErrorTurnstile",
	"rate-limited": "reportErrorRateLimited",
	server: "reportErrorServer"
} as const satisfies Record<ReportError, string>

// The footer's "Report abuse": styled by the caller, opening the dialog, which mounts on open. What the
// visitor is on (the accepted password, the browse path) is read from the link views at that moment.
export function ReportAbuseButton({ className, signedIn }: { className?: string; signedIn: boolean }) {
	const { t } = useTranslation("publicLinks")
	const subjectRef = useReportSubjectRef()
	const [subject, setSubject] = useState<ReportSubject | null>(null)

	return (
		<>
			<button
				type="button"
				className={className}
				onClick={() => {
					setSubject(subjectRef?.current ?? EMPTY_REPORT_SUBJECT)
				}}
			>
				{t("reportAbuse")}
			</button>
			{subject === null ? null : (
				<ReportAbuseDialog
					subject={subject}
					signedIn={signedIn}
					onClose={() => {
						setSubject(null)
					}}
				/>
			)}
		</>
	)
}

export function ReportAbuseDialog({ subject, signedIn, onClose }: { subject: ReportSubject; signedIn: boolean; onClose: () => void }) {
	const { t } = useTranslation(["publicLinks", "common"])
	const id = useId()
	const isOnline = useIsOnline()
	// A signed-in visitor's own address, from the account the app already holds; editable.
	const [form, setForm] = useState<ReportForm>(() => ({
		reason: null,
		email: signedIn ? (accountQueryGet()?.email ?? "") : "",
		comment: ""
	}))
	const [token, setToken] = useState<string | null>(null)
	// Remounts the challenge for a fresh token after a failed send.
	const [challengeKey, setChallengeKey] = useState(0)
	const [challengeFailed, setChallengeFailed] = useState(false)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<ReportError | null>(null)
	const inFlight = useRef<AbortController | null>(null)

	useEffect(() => {
		return () => {
			inFlight.current?.abort()
		}
	}, [])

	function handleSubmit(e: SubmitEvent): void {
		e.preventDefault()

		const report = buildAbuseReport(form, subject, window.location.href)

		if (report === null || token === null || pending) {
			return
		}

		const controller = new AbortController()

		inFlight.current = controller
		setPending(true)
		setError(null)

		void submitAbuseReport(report, token, controller.signal).then(outcome => {
			if (controller.signal.aborted) {
				return
			}

			inFlight.current = null
			setPending(false)

			if (outcome.status === "sent") {
				toast.success(t("reportSent"))
				onClose()

				return
			}

			setError(outcome.error)
			setToken(null)
			setChallengeKey(key => key + 1)
		})
	}

	const errorMessage = error !== null ? t(ERROR_LABEL_KEYS[error]) : challengeFailed ? t("reportChallengeFailed") : null

	return (
		<FormDialog
			open
			pending={pending}
			title={t("reportAbuse")}
			submitLabel={t("reportSend")}
			cancelLabel={t("common:cancel")}
			canSubmit={isOnline && canSendReport(form, token)}
			submitTitle={!isOnline ? t("common:offlineActionDisabled") : undefined}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onSubmit={handleSubmit}
		>
			<FieldGroup>
				<Field>
					<FieldLabel id={`${id}-reason-label`}>{t("reportReasonLabel")}</FieldLabel>
					<RadioGroup
						aria-labelledby={`${id}-reason-label`}
						name={`${id}-reason`}
						value={form.reason}
						disabled={pending}
						className="flex flex-col gap-2"
						onValueChange={(next: unknown) => {
							if (isReportReason(next)) {
								setForm(current => ({ ...current, reason: next }))
							}
						}}
					>
						{REPORT_REASONS.map(reason => (
							<div
								key={reason}
								className="flex items-center gap-2"
							>
								<RadioGroupItem
									id={`${id}-${reason}`}
									value={reason}
								/>
								<Label htmlFor={`${id}-${reason}`}>{t(REASON_LABEL_KEYS[reason])}</Label>
							</div>
						))}
					</RadioGroup>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-email`}>{t("reportEmailLabel")}</FieldLabel>
					<Input
						id={`${id}-email`}
						// Not type="email": Send is gated on the shared check instead of the browser's.
						inputMode="email"
						autoComplete="email"
						placeholder={t("reportEmailPlaceholder")}
						value={form.email}
						disabled={pending}
						onChange={e => {
							const next = e.target.value

							setForm(current => ({ ...current, email: next }))
						}}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-details`}>{t("reportDetailsLabel")}</FieldLabel>
					<textarea
						id={`${id}-details`}
						rows={3}
						maxLength={REPORT_COMMENT_MAX_LENGTH}
						value={form.comment}
						disabled={pending}
						className={cn(
							"w-full resize-y px-2.5 py-1.5 text-base leading-5 md:text-sm",
							FIELD_CONTROL_CLASS,
							INVALID_RING_CLASS
						)}
						onChange={e => {
							const next = e.target.value

							setForm(current => ({ ...current, comment: next }))
						}}
					/>
				</Field>
				<p className="flex gap-2 text-sm text-muted-foreground">
					<InfoIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0"
					/>
					<span>{hasReportPassword(subject) ? t("reportNoteWithPassword") : t("reportNote")}</span>
				</p>
				<ReportChallenge
					key={challengeKey}
					onToken={next => {
						setToken(next)

						if (next !== null) {
							setChallengeFailed(false)
						}
					}}
					onError={() => {
						setChallengeFailed(true)
					}}
				/>
				{errorMessage === null ? null : <FieldError>{errorMessage}</FieldError>}
			</FieldGroup>
		</FormDialog>
	)
}
