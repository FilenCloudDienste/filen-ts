import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { rerunExtractWithPassword } from "@/features/drive/lib/archiveJobs"
import { ARCHIVE_PASSWORD_MAX_CHARS, archivePasswordProblem } from "@/features/drive/lib/archivePassword"
import {
	armPasswordPrompt,
	clearQueuedPasswordPrompts,
	closePasswordPrompt,
	needsExtractPassword,
	useQueuedPasswordPrompts
} from "@/features/transfers/lib/extractPasswordPrompt"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { ArchivePasswordInput } from "@/features/drive/components/archivePasswordInput"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"

interface PasswordPrompt {
	id: string
	name: string
	wrong: boolean
}

// Primitives only, so the dialog re-renders when they change, not on every update of the job.
function passwordPrompt(job: DriveJob | undefined): PasswordPrompt | null {
	return job !== undefined && needsExtractPassword(job)
		? { id: job.id, name: job.archiveName, wrong: job.outcome.status === "wrongPassword" }
		: null
}

// The one password prompt for an extract that settled needing a password (lib/extractPasswordPrompt.ts
// decides which and when), mounted once at the root beside the toasts. Answering reruns the same job,
// card and all; dismissing leaves it waiting, its card still offering "Enter password".
export function ExtractPasswordDialog() {
	const promptId = useDriveJobsStore(state => state.passwordPromptId)
	const prompt = useDriveJobsStore(
		useShallow(state => passwordPrompt(state.passwordPromptId === null ? undefined : state.jobs[state.passwordPromptId]))
	)
	// The last prompt shown keeps its words through the exit animation. `prompt` is stable while unchanged.
	const [shown, setShown] = useState<PasswordPrompt | null>(prompt)

	if (prompt !== null && prompt !== shown) {
		setShown(prompt)
	}

	// Asked for a job that no longer waits (rerun, or gone): the next one in line gets the prompt.
	useEffect(() => {
		if (promptId !== null && prompt === null) {
			closePasswordPrompt()
		}
	}, [promptId, prompt])

	const view = prompt ?? shown

	return view === null ? null : (
		<ExtractPasswordForm
			key={view.id}
			prompt={view}
			open={prompt !== null}
		/>
	)
}

function ExtractPasswordForm({ prompt, open }: { prompt: PasswordPrompt; open: boolean }) {
	const { t } = useTranslation(["archive", "common"])
	const isOnline = useIsOnline()
	const queued = useQueuedPasswordPrompts()
	// Held only here and, once submitted, as the job's secret (jobSecrets.ts): never in a store or a log.
	const [password, setPassword] = useState("")
	const [revealed, setRevealed] = useState(false)
	const [applyToQueued, setApplyToQueued] = useState(false)
	const others = queued.length
	const passwordId = `extract-password-${prompt.id}`
	const problem = archivePasswordProblem(password)

	function close(): void {
		setPassword("")
		closePasswordPrompt()
	}

	function submit(): void {
		const ids = applyToQueued && others > 0 ? [prompt.id, ...queued] : [prompt.id]

		for (const id of ids) {
			if (rerunExtractWithPassword(id, password)) {
				armPasswordPrompt(id)
			}
		}

		if (ids.length > 1) {
			clearQueuedPasswordPrompts()
		}

		close()
	}

	return (
		<FormDialog
			open={open}
			pending={false}
			title={t(prompt.wrong ? "archiveWrongPasswordTitle" : "archivePasswordRequiredTitle")}
			description={t(prompt.wrong ? "archiveWrongPasswordBody" : "archivePasswordRequiredBody", { name: prompt.name })}
			submitLabel={t("archivePasswordSubmit")}
			cancelLabel={t("common:cancel")}
			canSubmit={problem === null && isOnline}
			submitTitle={!isOnline ? t("common:offlineActionDisabled") : undefined}
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
			onSubmit={e => {
				e.preventDefault()

				if (problem === null && isOnline) {
					submit()
				}
			}}
		>
			<FieldGroup>
				<Field data-invalid={problem === "tooLong" ? true : undefined}>
					<FieldLabel htmlFor={passwordId}>{t("archivePasswordLabel")}</FieldLabel>
					<ArchivePasswordInput
						id={passwordId}
						autoFocus
						value={password}
						revealed={revealed}
						aria-invalid={problem === "tooLong" ? true : undefined}
						aria-describedby={problem === "tooLong" ? `${passwordId}-error` : undefined}
						onRevealedChange={setRevealed}
						onChange={e => {
							setPassword(e.target.value)
						}}
					/>
					{problem === "tooLong" ? (
						<FieldError id={`${passwordId}-error`}>
							{t("archivePasswordTooLong", { max: ARCHIVE_PASSWORD_MAX_CHARS })}
						</FieldError>
					) : null}
				</Field>
				{others > 0 ? (
					<Field orientation="horizontal">
						<FieldContent>
							<FieldLabel htmlFor={`${passwordId}-all`}>{t("archivePasswordApplyAll", { count: others })}</FieldLabel>
						</FieldContent>
						<Switch
							id={`${passwordId}-all`}
							checked={applyToQueued}
							onCheckedChange={setApplyToQueued}
						/>
					</Field>
				) : null}
			</FieldGroup>
		</FormDialog>
	)
}
