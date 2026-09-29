import type { ComponentProps, ReactNode } from "react"
import { FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { CapsLockWarning } from "@/features/auth/components/capsLockWarning"
import { useCapsLock } from "@/features/auth/lib/useCapsLock"

type PasswordInputProps = Omit<
	ComponentProps<typeof Input>,
	"id" | "type" | "children" | "onKeyDown" | "onKeyUp" | "onBlur" | "aria-invalid" | "aria-describedby"
> & {
	id: string
	// A field that can fail validation passes the message, or false while it is valid; omitted, the input
	// carries no invalid state at all.
	error?: string | false
	// Rendered between the input and its error, e.g. a strength meter.
	children?: ReactNode
}

// An account-password input with its own caps-lock hint, for use inside a Field.
function PasswordInput({ id, error, children, ...props }: PasswordInputProps) {
	const caps = useCapsLock()
	const errorId = `${id}-error`

	return (
		<>
			<Input
				{...props}
				id={id}
				type="password"
				aria-invalid={error === undefined ? undefined : error !== false}
				// Same condition the error below renders on — a describedby pointing at an id that is not in the
				// document describes nothing.
				aria-describedby={error ? errorId : undefined}
				onKeyDown={caps.onKeyDown}
				onKeyUp={caps.onKeyUp}
				onBlur={caps.onBlur}
			/>
			{children}
			{error && <FieldError id={errorId}>{error}</FieldError>}
			<CapsLockWarning active={caps.capsLockOn} />
		</>
	)
}

export { PasswordInput }
