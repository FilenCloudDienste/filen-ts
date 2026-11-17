import { msgBytes } from "@filen/office/testing/msg"

// An Outlook message: an HTML body, a sender, and an embedded message with a text body.
export function outlookMessage(): Promise<Uint8Array> {
	return msgBytes({
		subject: "Status report",
		sender: ["Anna Berg", "anna@example.com"],
		to: [["Bob", "bob@example.com"]],
		html: "<p>All green</p>",
		attachments: [{ name: "Earlier thread", message: { subject: "Earlier thread", text: "Inner text" } }]
	})
}
