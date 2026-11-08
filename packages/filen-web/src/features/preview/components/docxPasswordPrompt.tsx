import { useEffect, useId, useRef, useState, type RefObject, type SubmitEvent } from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { LockIcon } from "lucide-react"
import { ArchivePasswordInput } from "@/features/drive/components/archivePasswordInput"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { log } from "@/lib/log"
import { usePasswordDraft, type PasswordDraft } from "@/features/preview/lib/passwordDraft"

// What a password check found: the caller closes the prompt on "accepted"; "aborted" is the user's cancel.
export type PasswordVerdict = "accepted" | "wrong" | "aborted"

export interface DocxPasswordPromptProps {
	open: boolean
	title: string
	body: string
	// Under the field after a wrong password.
	wrongMessage: string
	label: string
	submitLabel: string
	// Shown while `verify` runs, which can take seconds (the password's key derivation).
	progressLabel: string
	// Checks a password; never rejects. `signal` aborts when the user cancels or the prompt goes away.
	verify: (password: string, signal: AbortSignal) => Promise<PasswordVerdict>
	onOpenChange: (open: boolean) => void
	// Where focus goes when the prompt closes (default: where it was before it opened).
	finalFocus?: RefObject<HTMLElement | null>
	// What was typed, kept beyond this prompt: it starts from it and keeps it up to date.
	draft?: PasswordDraft | undefined
}

// A document's password, asked in the preview (nested in the overlay's dialog, as the archive and PDF prompts
// are): masked with a show/hide toggle, never offered to or saved by a password manager. While the check runs
// the field is locked and Cancel (or Escape) stops it; a wrong password clears the field for another try. The
// typed password lives only in this component's state (and the `draft` given, see PasswordDraft) and is
// dropped after each check.
export function DocxPasswordPrompt({
	open,
	title,
	body,
	wrongMessage,
	label,
	submitLabel,
	progressLabel,
	verify,
	onOpenChange,
	finalFocus,
	draft
}: DocxPasswordPromptProps) {
	const { t } = useTranslation("common")
	const id = useId()
	const fieldId = `${id}-password`
	const errorId = `${id}-error`
	const [password, setPassword] = useState(() => draft?.password ?? "")
	const [revealed, setRevealed] = useState(() => draft?.revealed ?? false)
	const [wrong, setWrong] = useState(false)
	const [verifying, setVerifying] = useState<AbortController | null>(null)
	const [wasOpen, setWasOpen] = useState(open)
	const verifyingRef = useRef<AbortController | null>(null)
	const inputRef = useRef<HTMLInputElement | null>(null)
	const cancelRef = useRef<HTMLButtonElement | null>(null)

	// Each opening starts blank.
	if (open !== wasOpen) {
		setWasOpen(open)

		if (open) {
			setPassword("")
			setWrong(false)
		}
	}

	useEffect(
		() => () => {
			verifyingRef.current?.abort()
		},
		[]
	)

	const stop = (): void => {
		verifyingRef.current?.abort()
		verifyingRef.current = null
		flushSync(() => {
			setVerifying(null)
		})
		inputRef.current?.focus()
	}

	const settle = (controller: AbortController, verdict: PasswordVerdict): void => {
		if (verifyingRef.current !== controller) {
			return
		}

		verifyingRef.current = null
		flushSync(() => {
			setVerifying(null)

			if (verdict === "wrong") {
				setWrong(true)
			}
		})

		if (verdict !== "accepted") {
			inputRef.current?.focus()
		}
	}

	const submit = (event: SubmitEvent): void => {
		event.preventDefault()

		if (verifying !== null || password.length === 0) {
			return
		}

		const controller = new AbortController()
		const typed = password

		verifyingRef.current = controller
		// The field is disabled while the check runs: focus moves to the one control that still acts.
		flushSync(() => {
			setVerifying(controller)
			setPassword("")
			setWrong(false)
		})
		draft?.keep("", revealed)
		cancelRef.current?.focus()

		verify(typed, controller.signal).then(
			verdict => {
				settle(controller, verdict)
			},
			(error: unknown) => {
				log.error("preview", "password check failed", error)
				settle(controller, "aborted")
			}
		)
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next, details) => {
				// Dismissing while the check runs stops the check; the prompt stays for another try.
				if (!next && verifyingRef.current !== null) {
					details.cancel()
					stop()

					return
				}

				onOpenChange(next)
			}}
		>
			{/* The dialog's own initial focus, not autoFocus: a preview overlay opened just before queues its initial
			focus for the next frame, which only a newer request cancels. */}
			<DialogContent
				initialFocus={inputRef}
				{...(finalFocus === undefined ? {} : { finalFocus })}
			>
				<form
					onSubmit={submit}
					className="flex flex-col gap-6"
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{body}</DialogDescription>
					</DialogHeader>
					<Field data-invalid={wrong ? true : undefined}>
						<FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
						<ArchivePasswordInput
							ref={inputRef}
							id={fieldId}
							value={password}
							disabled={verifying !== null}
							revealed={revealed}
							aria-invalid={wrong ? true : undefined}
							aria-describedby={wrong ? errorId : undefined}
							onRevealedChange={next => {
								setRevealed(next)
								draft?.keep(password, next)
							}}
							onChange={event => {
								setPassword(event.target.value)
								draft?.keep(event.target.value, revealed)
							}}
						/>
						{wrong ? <FieldError id={errorId}>{wrongMessage}</FieldError> : null}
					</Field>
					<p
						role="status"
						className="sr-only"
					>
						{verifying === null ? "" : progressLabel}
					</p>
					<DialogFooter>
						<Button
							ref={cancelRef}
							type="button"
							variant="outline"
							onClick={() => {
								if (verifyingRef.current !== null) {
									stop()
								} else {
									onOpenChange(false)
								}
							}}
						>
							{t("cancel")}
						</Button>
						<Button
							type="submit"
							disabled={verifying !== null || password.length === 0}
						>
							{verifying === null ? null : (
								<Spinner
									data-icon="inline-start"
									aria-hidden="true"
									role={undefined}
								/>
							)}
							{verifying === null ? submitLabel : progressLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export interface DocxPasswordGateProps extends Omit<DocxPasswordPromptProps, "open" | "onOpenChange" | "finalFocus"> {
	// In the document's place, behind the prompt.
	message: string
	// Brings a dismissed prompt back.
	enterLabel: string
}

// Nothing can be shown without the password: a lock in the document's place, the prompt over it. Dismissing the
// prompt leaves its button to bring it back, which takes focus. In a preview overlay, a newer version of the file
// shown meanwhile asks again as this one was left: dismissed, or with what was typed (PasswordDraft).
export function DocxPasswordGate({ message, enterLabel, ...prompt }: DocxPasswordGateProps) {
	const draft = usePasswordDraft()
	const [dismissed, setDismissed] = useState(() => draft?.dismissed ?? false)
	const enterRef = useRef<HTMLButtonElement | null>(null)

	return (
		<div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
			<LockIcon
				aria-hidden="true"
				className="size-8 text-muted-foreground"
			/>
			<p className="text-sm text-muted-foreground">{message}</p>
			<Button
				ref={enterRef}
				variant="outline"
				onClick={() => {
					setDismissed(false)
					draft?.dismiss(false)
				}}
			>
				{enterLabel}
			</Button>
			<DocxPasswordPrompt
				{...prompt}
				open={!dismissed}
				finalFocus={enterRef}
				draft={draft}
				onOpenChange={open => {
					setDismissed(!open)
					draft?.dismiss(!open)
				}}
			/>
		</div>
	)
}
