import { createContext } from "react"

// The drive or link file a message's attachments are saved from: a message itself, or the mailbox it is in. Its uuid is
// what a link visitor's save permission is asked of; its parent where Save to drive opens. null for a message held in a
// file that is not one (an archive's entry): nothing to ask, the drive's root to open at. undefined outside a message.
export interface EmailLinkRoot {
	readonly uuid: string
	readonly parent: string | null
}

export const EmailLinkRootContext = createContext<EmailLinkRoot | null | undefined>(undefined)
