import { useState } from "react"
import type { DesktopCredentialProtocol, DesktopServeCredentials, DesktopServeProtocol } from "@filen/shared/desktop"
import { mountsApi } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"

function partsOf(credentials: DesktopServeCredentials): { user: string; secret: string } {
	return credentials.kind === "s3"
		? { user: credentials.accessKeyId, secret: credentials.secretAccessKey }
		: { user: credentials.user, secret: credentials.password }
}

export interface ServeCredentialsState {
	protocol: DesktopCredentialProtocol
	// The shown credentials; null while hidden. Forgotten with the page.
	revealed: { user: string; secret: string } | null
	revealing: boolean
	toggle: () => void
	// After the credentials changed: shown ones are read again so the page never shows credentials that no longer work.
	changed: () => void
}

// A server's credentials, made at random by the shell and shown on request: one state for the hero's rows and the
// section that replaces them. null for nfs, which takes none.
export function useServeCredentials(serveProtocol: DesktopServeProtocol): ServeCredentialsState | null {
	const [revealed, setRevealed] = useState<{ user: string; secret: string } | null>(null)
	const [revealing, setRevealing] = useState(false)

	if (serveProtocol === "nfs") {
		return null
	}

	const protocol = serveProtocol

	async function reveal(): Promise<void> {
		setRevealing(true)

		const done = await runMountsAction(() => mountsApi().credentials(protocol))

		setRevealing(false)
		setRevealed(done === null ? null : partsOf(done.value))
	}

	return {
		protocol,
		revealed,
		revealing,
		toggle: () => {
			if (revealed === null) {
				void reveal()
			} else {
				setRevealed(null)
			}
		},
		changed: () => {
			if (revealed !== null) {
				void reveal()
			}
		}
	}
}
