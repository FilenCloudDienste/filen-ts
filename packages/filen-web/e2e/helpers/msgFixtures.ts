import { msgBytes } from "@filen/office/testing/msg"
import { EMAIL_REMOTE } from "../fixtures/text"

// An Outlook message whose HTML asks for a remote picture and shows its own (cid:), with an embedded message: nothing
// remote may load.
export const MSG_SUBJECT = "E2E status report"
export const MSG_EMBEDDED_SUBJECT = "E2E earlier thread"
export const MSG_EMBEDDED_TEXT = "the earlier thread's text"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

export async function outlookMessageBytes(): Promise<Buffer> {
	return Buffer.from(
		await msgBytes({
			subject: MSG_SUBJECT,
			sender: ["Anna Berg", "anna@example.com"],
			to: [["Bob", "bob@example.com"]],
			date: "2026-11-16T09:14:00.000Z",
			html: `<html><body><p>All green</p><img src="cid:chart@e2e" alt="chart"><img src="${EMAIL_REMOTE}/pixel.gif" alt="pixel"></body></html>`,
			attachments: [
				{ name: "chart.png", mimeType: "image/png", contentId: "chart@e2e", hidden: true, bytes: Uint8Array.from(PNG) },
				{ name: MSG_EMBEDDED_SUBJECT, message: { subject: MSG_EMBEDDED_SUBJECT, text: MSG_EMBEDDED_TEXT } }
			]
		})
	)
}
