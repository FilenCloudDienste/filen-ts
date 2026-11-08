import { useLayoutEffect } from "react"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"

// The editor's trusted-domain gate for links it follows: hands `register` what opens a web or mail link in a new
// tab with no opener once its domain is trusted (asked once per domain), and renders the confirmation.
export function DocxLinkGate({ register }: { register: (open: (href: string) => void) => void }) {
	const gate = useTrustedLinkGate()

	useLayoutEffect(() => {
		register(href => {
			if (!gate.intercept(href)) {
				window.open(href, "_blank", "noopener,noreferrer")
			}
		})
	})

	return gate.dialog
}
