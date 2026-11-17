// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { PreviewAccessModeProvider } from "@/features/preview/lib/accessMode"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { readEmail } from "@/features/preview/lib/emailReading"
import { outlookMessage } from "@/tests/fixtures/outlookMessage"

// A message (E1): its headers, its HTML sanitized with its remote content counted and its inline pictures resolved,
// its text and source; attachments listed (inline pictures not), opened in place and back.

const { downloads, linkSaveAsks } = vi.hoisted(() => ({
	downloads: [] as string[],
	linkSaveAsks: [] as (string | null)[]
}))

vi.mock("@/lib/downloadBlob", () => ({
	downloadBlob: (name: string) => {
		downloads.push(name)
	}
}))
vi.mock("@/features/publicLinks/queries/publicLink", () => ({
	useLinkSaveable: (_kind: string, uuid: string | null) => {
		linkSaveAsks.push(uuid)

		return false
	}
}))

const { message } = vi.hoisted((): { message: { current: string | Uint8Array } } => ({ message: { current: "" } }))

// A small text cap, so bodies and files past it stay small here.
vi.mock("@/features/preview/lib/previewCaps", () => ({ TEXT_CAP: 4096, EMAIL_MAX_BYTES: 67_108_864 }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve(),
	kvKeys: () => Promise.resolve([])
}))
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		downloadOriginBytes: vi.fn(),
		cancelPreviewDownload: () => Promise.resolve(),
		itemNameErrors: (names: string[]) => Promise.resolve(names.map(name => (name.includes(":") ? "ForbiddenChar" : null)))
	},
	threadCount: () => 1
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/hooks/usePreviewBytes")>(
		"@/features/preview/hooks/usePreviewBytes"
	)

	return {
		...actual,
		// The message's own bytes; an attachment (a provided origin) reads through the real hook.
		usePreviewBytes: (item: { data: { uuid: string } }) =>
			item.data.uuid === "mail-0000-0000-0000-000000000000"
				? {
						status: "success",
						bytes: typeof message.current === "string" ? new TextEncoder().encode(message.current) : message.current,
						refetch: vi.fn()
					}
				: actual.usePreviewBytes(item as never)
	}
})
vi.mock("@/features/preview/lib/textFamilyClient", () => ({
	readEmailFile: (bytes: Uint8Array) => readEmail(new Uint8Array(bytes))
}))
// The frame is SafeHtmlDocument's own test's: here, what it is given.
vi.mock("@/features/preview/components/safeHtmlDocument", () => ({
	SafeHtmlDocument: ({ html, links }: { html: string; links: readonly unknown[] }) => (
		<div
			data-testid="html-body"
			data-html={html}
			data-links={links.length}
		/>
	)
}))

const { EmailViewer } = await import("@/features/preview/components/emailViewer")

registerAllActions()

const mintedTypes: string[] = []

beforeAll(() => {
	URL.createObjectURL = (blob: Blob | MediaSource) => {
		mintedTypes.push(blob instanceof Blob ? blob.type : "")

		return "blob:https://app.example/chart"
	}
	URL.revokeObjectURL = () => undefined
})

afterEach(() => {
	cleanup()
})

const ITEM = narrowItem({
	uuid: "mail-0000-0000-0000-000000000000",
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 100n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "numbers.eml", mime: "message/rfc822", modified: 0n, size: 100n, key: "k", version: 2 } }
} satisfies File)

const MESSAGE = [
	'From: "Anna Berg" <anna@example.com>',
	"To: me@example.com",
	"Cc: a@x.io, b@x.io, c@x.io",
	"Subject: Quarterly numbers",
	"Date: Mon, 16 Nov 2026 09:14:00 +0000",
	'Content-Type: multipart/mixed; boundary="outer"',
	"",
	"--outer",
	'Content-Type: multipart/related; boundary="rel"',
	"",
	"--rel",
	"Content-Type: text/html; charset=utf-8",
	"",
	'<p>Hi <a href="https://example.com/q">report</a> <img src="cid:chart@x"> <img src="https://tracker.e2e.example/p.gif"></p>',
	"--rel",
	"Content-Type: image/png",
	"Content-ID: <chart@x>",
	"Content-Disposition: inline",
	"Content-Transfer-Encoding: base64",
	"",
	"iVBORw0KGgo=",
	"--rel--",
	"--outer",
	'Content-Type: text/plain; name="notes.txt"',
	'Content-Disposition: attachment; filename="notes.txt"',
	"",
	"notes from an attachment",
	"--outer--",
	""
].join("\r\n")

function mount(): void {
	message.current = MESSAGE
	render(<EmailViewer item={ITEM} />, { wrapper: queryClientWrapper(createTestQueryClient()) })
}

describe("EmailViewer", () => {
	it("shows the headers and the sanitized HTML, its remote content counted and its own picture resolved", async () => {
		mount()

		expect(await screen.findByRole("heading", { name: "Quarterly numbers" })).toBeTruthy()
		expect(screen.getByText("Anna Berg <anna@example.com>")).toBeTruthy()
		expect(screen.getByText("a@x.io, b@x.io")).toBeTruthy()
		expect(screen.getByRole("button", { name: "+1 more" })).toBeTruthy()
		const body = await screen.findByTestId("html-body")

		expect(screen.getByText("1 remote resource was not loaded.")).toBeTruthy()
		const html = body.getAttribute("data-html") ?? ""

		expect(html).toContain("blob:https://app.example/chart")
		// Typed by its bytes (the part declares image/png too, but only the sniffed type reaches the URL).
		expect(mintedTypes).toContain("image/png")
		expect(html).not.toContain("tracker.e2e.example")
		expect(body.getAttribute("data-links")).toBe("1")
		expect(screen.getByRole("button", { name: "HTML" }).getAttribute("aria-pressed")).toBe("true")
	})

	it("lists the attachments but not the inline picture, and opens one in place and back", async () => {
		mount()

		expect(await screen.findByText("Attachments (1)")).toBeTruthy()
		expect(screen.getByText("notes.txt")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Save to drive" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Open" }))

		expect(await screen.findByText("notes from an attachment")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Back to the message" }))

		expect(await screen.findByRole("heading", { name: "Quarterly numbers" })).toBeTruthy()
	})

	it("expands the recipients", async () => {
		mount()

		fireEvent.click(await screen.findByRole("button", { name: "+1 more" }))

		expect(screen.getByText("a@x.io, b@x.io, c@x.io")).toBeTruthy()
	})

	it("shows an Outlook message without a source view, and opens its embedded message as a message", async () => {
		message.current = await outlookMessage()
		render(<EmailViewer item={ITEM} />, { wrapper: queryClientWrapper(createTestQueryClient()) })

		expect(await screen.findByRole("heading", { name: "Status report" })).toBeTruthy()
		expect(screen.getByText("Anna Berg <anna@example.com>")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Source" })).toBeNull()
		expect((await screen.findByTestId("html-body")).getAttribute("data-html")).toContain("All green")
		expect(screen.getByText("Earlier thread.msg")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Open" }))

		expect(await screen.findByRole("heading", { name: "Earlier thread" })).toBeTruthy()
		expect(screen.getByText("Inner text")).toBeTruthy()
	})

	it("lists a part sent inline that the HTML does not show: a PDF, or a picture it never names", async () => {
		message.current = [
			"Subject: Inline parts",
			'Content-Type: multipart/related; boundary="r"',
			"",
			"--r",
			"Content-Type: text/html",
			"",
			"<p>See attached</p>",
			"--r",
			'Content-Type: application/pdf; name="terms.pdf"',
			"Content-ID: <terms@x>",
			'Content-Disposition: inline; filename="terms.pdf"',
			"",
			"%PDF-1.7",
			"--r",
			'Content-Type: image/png; name="unused.png"',
			"Content-ID: <unused@x>",
			"Content-Disposition: inline",
			"Content-Transfer-Encoding: base64",
			"",
			"iVBORw0KGgo=",
			"--r--",
			""
		].join("\r\n")
		render(<EmailViewer item={ITEM} />, { wrapper: queryClientWrapper(createTestQueryClient()) })

		expect(await screen.findByText("Attachments (2)")).toBeTruthy()
		expect(screen.getByText("terms.pdf")).toBeTruthy()
		expect(screen.getByText("unused.png")).toBeTruthy()
	})

	it("downloads under a name the drive takes, and on a link asks about saving of the link's own file only", async () => {
		message.current = [
			"Subject: Outer",
			'Content-Type: multipart/mixed; boundary="o"',
			"",
			"--o",
			"Content-Type: text/plain",
			"",
			"outer body",
			"--o",
			'Content-Type: message/rfc822; name="Re: Meeting.eml"',
			'Content-Disposition: attachment; filename="Re: Meeting.eml"',
			"",
			"Subject: Inner",
			'Content-Type: multipart/mixed; boundary="i"',
			"",
			"--i",
			"Content-Type: text/plain",
			"",
			"inner body",
			"--i",
			'Content-Type: text/plain; name="notes.txt"',
			'Content-Disposition: attachment; filename="notes.txt"',
			"",
			"notes",
			"--i--",
			"--o--",
			""
		].join("\r\n")
		linkSaveAsks.length = 0
		render(
			<PreviewAccessModeProvider mode="anon">
				<EmailViewer item={ITEM} />
			</PreviewAccessModeProvider>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		fireEvent.click(await screen.findByRole("button", { name: "Download" }))
		await vi.waitFor(() => {
			expect(downloads).toContain("Re__Meeting.eml")
		})

		fireEvent.click(screen.getByRole("button", { name: "Open" }))

		expect(await screen.findByRole("heading", { name: "Inner" })).toBeTruthy()
		expect(screen.getByText("notes.txt")).toBeTruthy()
		expect(linkSaveAsks.length).toBeGreaterThan(0)
		expect(linkSaveAsks.every(uuid => uuid === ITEM.data.uuid)).toBe(true)
	})

	it("shows a cut text body under a notice, an HTML body past the cap as too large, and no source past the text cap", async () => {
		const long = "y".repeat(5000)

		message.current = [
			"Subject: Long",
			'Content-Type: multipart/alternative; boundary="a"',
			"",
			"--a",
			"Content-Type: text/plain",
			"",
			long,
			"--a",
			"Content-Type: text/html",
			"",
			`<p>${long}</p>`,
			"--a--",
			""
		].join("\r\n")
		render(<EmailViewer item={{ ...ITEM, data: { ...ITEM.data, size: 20_000n } } as typeof ITEM} />, {
			wrapper: queryClientWrapper(createTestQueryClient())
		})

		expect(await screen.findByText("This formatted content is too large to show.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Text" }))

		expect(await screen.findByText("This text is longer than can be shown here; only its start is shown.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Source" }))

		expect(await screen.findByText("This file is too large to show as text.")).toBeTruthy()
	})

	it("shows Reply to only when it differs from the sender, and an international domain as written under the address", async () => {
		message.current = ["From: Anna <anna@acm\u00e9.com>", "Reply-To: drop@y.io", "Subject: Cues", "", "x", ""].join("\r\n")
		render(<EmailViewer item={ITEM} />, { wrapper: queryClientWrapper(createTestQueryClient()) })

		expect(await screen.findByText("Anna <anna@xn--acm-dma.com>")).toBeTruthy()
		expect(screen.getByText("Domain written as:", { exact: false }).textContent).toBe("Domain written as: acm\u00e9.com")
		expect(screen.getByText("Reply to")).toBeTruthy()
		expect(screen.getByText("drop@y.io")).toBeTruthy()

		cleanup()
		message.current = ["From: Anna <anna@x.io>", "Reply-To: anna@x.io", "Subject: Same", "", "x", ""].join("\r\n")
		render(<EmailViewer item={ITEM} />, { wrapper: queryClientWrapper(createTestQueryClient()) })

		expect(await screen.findByText("Anna <anna@x.io>")).toBeTruthy()
		expect(screen.queryByText("Reply to")).toBeNull()
		expect(screen.queryByText("Domain written as:", { exact: false })).toBeNull()
	})
})
