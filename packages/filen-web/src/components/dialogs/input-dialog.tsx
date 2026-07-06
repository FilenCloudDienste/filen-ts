import { useState, type SubmitEvent } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface InputDialogProps {
	open: boolean
	pending: boolean
	title: string
	body: string
	label: string
	placeholder?: string | undefined
	submitLabel: string
	validate: (value: string) => boolean
	onOpenChange: (open: boolean) => void
	onSubmit: (value: string) => void
}

// Generic single-field prompt built on the dialog primitive — the shared base for "type a value and
// submit" flows (the pre-primitive forgot-password dialog's shape, generalized). Namespace-agnostic
// like every dialog primitive in this directory: every label is caller-resolved. The typed value
// always starts blank and resets on every open transition (adjusting state during render, same
// "reset state when a prop changes" pattern the forgot-password dialog and TypedConfirmDialog use)
// so a dismissed prompt never resurfaces a stale value the next time it opens.
function InputDialog({ open, pending, title, body, label, placeholder, submitLabel, validate, onOpenChange, onSubmit }: InputDialogProps) {
	const [wasOpen, setWasOpen] = useState(open)
	const [value, setValue] = useState("")
	if (open !== wasOpen) {
		setWasOpen(open)
		if (open) {
			setValue("")
		}
	}
	const valid = validate(value)

	function handleSubmit(e: SubmitEvent): void {
		e.preventDefault()
		if (pending || !valid) {
			return
		}
		onSubmit(value)
	}

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent>
				<form
					onSubmit={handleSubmit}
					className="flex flex-col gap-6"
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{body}</DialogDescription>
					</DialogHeader>
					<Field>
						<FieldLabel htmlFor="input-dialog-value">{label}</FieldLabel>
						<Input
							id="input-dialog-value"
							value={value}
							autoFocus
							placeholder={placeholder}
							disabled={pending}
							onChange={e => {
								setValue(e.target.value)
							}}
						/>
					</Field>
					<DialogFooter>
						<Button
							type="submit"
							disabled={pending || !valid}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export { InputDialog }
export type { InputDialogProps }
