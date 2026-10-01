import * as React from "react"
import { cn } from "@filen/shared"
import { Input } from "@/components/ui/input"

// The opt-outs the common password-manager extensions read: 1Password, LastPass, Bitwarden, Dashlane,
// Proton Pass.
const PASSWORD_MANAGER_OPT_OUTS = {
	"data-1p-ignore": "true",
	"data-lpignore": "true",
	"data-bwignore": "true",
	"data-form-type": "other",
	"data-protonpass-ignore": "true"
} as const

// Masked entry for a secret that is not the user's Filen login: a PDF's password, a shared link's. A
// password field is what browsers and password managers key on to offer saved logins and to save new
// ones (the browsers' own managers ignore autocomplete="off" there), so this is a text field masked by
// CSS instead, which no password manager treats as a credential.
function SecretInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type" | "autoComplete">) {
	return (
		<Input
			type="text"
			autoComplete="off"
			autoCapitalize="off"
			autoCorrect="off"
			spellCheck={false}
			{...PASSWORD_MANAGER_OPT_OUTS}
			className={cn("[-webkit-text-security:disc]", className)}
			{...props}
		/>
	)
}

export { SecretInput }
