import type { EmailAttachment } from "@/features/preview/lib/emailReading"

// A forwarded or embedded message (or a mailbox of them), which opens as a message one level deeper.
export function isMessageAttachment(attachment: Pick<EmailAttachment, "name" | "mimeType">): boolean {
	const name = attachment.name.toLowerCase()

	return (
		attachment.mimeType === "message/rfc822" ||
		attachment.mimeType === "application/vnd.ms-outlook" ||
		name.endsWith(".eml") ||
		name.endsWith(".msg") ||
		// A mailbox holds messages: it opens one level deeper too.
		name.endsWith(".mbox")
	)
}
