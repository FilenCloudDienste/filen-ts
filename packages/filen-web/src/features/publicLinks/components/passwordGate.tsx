import { useEffect, useRef, useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { LockIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CenteredSurface } from "@/features/publicLinks/components/publicLinkStates"

// Shared password gate for BOTH link kinds. Purely presentational over a 3-state input driven by the
// owning view's password flow (prompt → checking → wrong): a file link re-resolves getLinkedFile with
// the typed password, a directory link validates by listing the root with it set. The gate owns only
// the input's own text — the password never leaves this component except through onSubmit, and the
// owning view holds it in memory only (a reload re-prompts, mirroring old-web).
//
// LABEL-FIRST: a wrong password shows an inline field error, clears the input, and refocuses it.
export function PasswordGate({ state, onSubmit }: { state: "prompt" | "checking" | "wrong"; onSubmit: (password: string) => void }) {
	const { t } = useTranslation("publicLinks")
	const [value, setValue] = useState("")
	const inputRef = useRef<HTMLInputElement>(null)

	// Clear the input on the transition INTO the wrong state (React's documented "reset state when a
	// prop changes" during render, not an effect — avoids an extra commit and the set-state-in-effect
	// lint). Focus is a genuine DOM side effect, so it stays in an effect below.
	const [seenState, setSeenState] = useState(state)

	if (state !== seenState) {
		setSeenState(state)

		if (state === "wrong") {
			setValue("")
		}
	}

	useEffect(() => {
		if (state === "wrong") {
			inputRef.current?.focus()
		}
	}, [state])

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault()

		const password = value

		if (password.length > 0 && state !== "checking") {
			onSubmit(password)
		}
	}

	return (
		<CenteredSurface>
			<Card className="w-full max-w-sm">
				<CardHeader className="justify-items-center gap-3 text-center">
					<div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
						<LockIcon className="size-6" />
					</div>
					<div className="flex flex-col gap-1">
						<CardTitle>{t("passwordTitle")}</CardTitle>
						<CardDescription>{t("passwordBody")}</CardDescription>
					</div>
				</CardHeader>
				<CardContent>
					<form
						onSubmit={handleSubmit}
						className="flex flex-col gap-4"
					>
						<Field>
							<FieldLabel htmlFor="public-link-password">{t("passwordLabel")}</FieldLabel>
							<Input
								id="public-link-password"
								ref={inputRef}
								type="password"
								autoComplete="current-password"
								autoFocus={true}
								placeholder={t("passwordPlaceholder")}
								aria-invalid={state === "wrong"}
								value={value}
								onChange={event => {
									setValue(event.target.value)
								}}
							/>
							{state === "wrong" && <FieldError>{t("passwordWrong")}</FieldError>}
						</Field>
						<Button
							type="submit"
							disabled={value.length === 0 || state === "checking"}
						>
							{state === "checking" && <Spinner data-icon="inline-start" />}
							{t("passwordSubmit")}
						</Button>
					</form>
				</CardContent>
			</Card>
		</CenteredSurface>
	)
}
