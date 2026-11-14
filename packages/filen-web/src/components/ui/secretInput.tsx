import * as React from "react"
import { cn } from "@filen/shared"
import { PASSWORD_MANAGER_OPT_OUTS } from "@filen/shared/dom/formFieldNames"
import { Input } from "@/components/ui/input"

// Masked entry for a secret that is not the user's Filen login: a PDF's password, a shared link's. A
// password field is what browsers and password managers key on to offer saved logins and to save new
// ones (the browsers' own managers ignore autocomplete="off" there), so this is a text field masked by
// CSS instead, which no password manager treats as a credential. `revealed` shows the text; the opt-outs
// stay, so revealing never turns the field into a credential.
function SecretInput({
	className,
	revealed,
	...props
}: Omit<React.ComponentProps<"input">, "type" | "autoComplete"> & { revealed?: boolean | undefined }) {
	return (
		<Input
			type="text"
			autoComplete="off"
			autoCapitalize="off"
			autoCorrect="off"
			spellCheck={false}
			{...PASSWORD_MANAGER_OPT_OUTS}
			className={cn(revealed !== true && "[-webkit-text-security:disc]", className)}
			{...props}
		/>
	)
}

export { SecretInput }
