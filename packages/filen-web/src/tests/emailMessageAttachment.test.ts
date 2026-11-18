import { describe, expect, it } from "vitest"
import { isMessageAttachment } from "@/features/preview/lib/emailMessageAttachment"

// Attachments that open as messages one level deeper, so the depth limit counts them: forwarded messages, Outlook
// messages and mailboxes.

describe("isMessageAttachment", () => {
	it("counts messages and mailboxes, by type or name", () => {
		expect(isMessageAttachment({ name: "fwd.eml", mimeType: "application/octet-stream" })).toBe(true)
		expect(isMessageAttachment({ name: "x", mimeType: "message/rfc822" })).toBe(true)
		expect(isMessageAttachment({ name: "x.MSG", mimeType: "" })).toBe(true)
		expect(isMessageAttachment({ name: "archive.mbox", mimeType: "application/mbox" })).toBe(true)
		expect(isMessageAttachment({ name: "report.pdf", mimeType: "application/pdf" })).toBe(false)
	})
})
