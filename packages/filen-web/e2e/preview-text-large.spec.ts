import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, expect, settleLeases } from "./fixtures"
import { LARGE_UPLOAD_TIMEOUT_MS, LAZY_VIEWER_TIMEOUT_MS, uploadDiskFiles, withScratchDirectory } from "./helpers/listing"
import { previewOverlay } from "./helpers/archive"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest, trackForeignRequests } from "./helpers/requests"
import { resolveModKey } from "./helpers/modkey"

// Text files past the 32 MiB text cap open read-only in the large text viewer, read in ranges: a 40 MiB file with no
// line break reads a block or so per jump (never the line from its start), and find walks it to a match near its end;
// a 40 MiB file of Japanese lines whose 1 MiB block boundary cuts a three-byte character shows that character whole
// after Count lines and a go to its line. Nothing outside Filen is contacted. A write-lane spec: it uploads both into a
// scratch directory of its own.

const MIB = 1024 * 1024
const SIZE = 40 * MIB
// Blocks a jump may read: the one it lands in and the one beside it, with the read-ahead's two.
const JUMP_BLOCKS = 4
const NEEDLE = "needle-at-the-end"

// One line, no break: a repeating alphabet, the needle 1 MiB before the end.
function oneLine(): Buffer {
	const bytes = Buffer.alloc(SIZE)

	for (let at = 0; at < SIZE; at++) bytes[at] = 0x61 + (at % 26)

	bytes.write(NEEDLE, SIZE - MIB, "latin1")

	return bytes
}

// Numbered Japanese lines, padded at the start so the character at 1 MiB − 1 is a three-byte one: the line holding it,
// and that line's text.
function japaneseLines(): { bytes: Buffer; line: number; text: string } {
	const lines: string[] = []
	let length = 0

	for (let index = 1; length < SIZE; index++) {
		const line = `${String(index)} 日本語のテキストです`

		lines.push(line)
		length += Buffer.byteLength(line) + 1
	}

	const plain = Buffer.from(lines.join("\n"))
	let lead = MIB - 1

	// The last lead byte of a three-byte character at or before 1 MiB − 1.
	while ((plain[lead] ?? 0) < 0xe0) lead--

	const pad = MIB - 1 - lead
	const bytes = Buffer.concat([Buffer.from(" ".repeat(pad)), plain])
	const before = bytes.subarray(0, MIB - 1).toString("latin1")
	const line = before.split("\n").length

	return { bytes, line, text: lines[line - 1] ?? "" }
}

test("text past the cap opens in the large text viewer, read in ranges", async ({ page, context, browserName }) => {
	// One engine is enough for the uploads; the viewer is the same code on all three.
	test.skip(browserName !== "chromium", "the large text leg runs on Chromium only")
	test.setTimeout(600_000 + LARGE_UPLOAD_TIMEOUT_MS)

	const cspViolations = trackCspViolations(page)
	const requests = trackForeignRequests(context, { strictPreview: true })
	const dir = mkdtempSync(join(tmpdir(), "filen-e2e-large-text-"))

	try {
		await withScratchDirectory(page, "large-text", async ({ listbox, runId }) => {
			const flat = join(dir, `e2e-one-line-${runId}.log`)
			const japanese = join(dir, `e2e-japanese-${runId}.txt`)
			const lines = japaneseLines()

			writeFileSync(flat, oneLine())
			writeFileSync(japanese, lines.bytes)
			await uploadDiskFiles(page, [flat, japanese], listbox)
			await settleLeases(page)

			const egest = observeEgest(context)
			const dialog = previewOverlay(page)
			const mod = await resolveModKey(page)

			await listbox.getByRole("option", { name: `e2e-one-line-${runId}.log` }).dblclick()

			const rows = dialog.getByRole("document")

			await expect(dialog.getByText("Read-only", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await expect(dialog.getByRole("button", { name: "Encoding: UTF-8" })).toBeVisible()
			await expect(rows.getByText(/^abcdefghijklmnopqrstuvwxyz/).first()).toBeVisible()
			await expect(dialog.getByText("0%", { exact: true })).toBeVisible()

			// The end of a 40 MiB line: a block or so, not the line.
			await expect.poll(() => egest.requests() > 0, { timeout: LAZY_VIEWER_TIMEOUT_MS }).toBe(true)

			const opened = egest.requests()

			await rows.focus()
			await page.keyboard.press("End")
			await expect(dialog.getByText("100%", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			expect(egest.requests() - opened).toBeLessThanOrEqual(JUMP_BLOCKS)

			// Find walks the file to the needle and shows it.
			await page.keyboard.press(`${mod}+f`)
			await dialog.getByRole("searchbox", { name: "Find" }).fill(NEEDLE)
			await expect(dialog.getByText("1/1", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await expect(rows.locator("mark", { hasText: NEEDLE })).toBeVisible()

			await page.keyboard.press("Escape")
			await page.keyboard.press("Escape")
			await expect(dialog).toHaveCount(0)

			await listbox.getByRole("option", { name: `e2e-japanese-${runId}.txt` }).dblclick()
			await expect(dialog.getByText("Read-only", { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await dialog.getByRole("button", { name: "Count lines" }).click()
			await expect(dialog.getByText(/^[\d,]+ lines$/)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

			await dialog.getByRole("button", { name: "Go to line" }).click()
			await page.getByRole("textbox", { name: "Go to line" }).fill(String(lines.line))
			await page.keyboard.press("Enter")
			await expect(rows.getByText(lines.text, { exact: true })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
			await expect(rows.getByText(String(lines.line), { exact: true })).toBeVisible()
			await expect(rows.getByText(/�/)).toHaveCount(0)

			await page.keyboard.press("Escape")
			await expect(dialog).toHaveCount(0)
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}

	expect(cspViolations).toEqual([])
	expect(requests.foreign).toEqual([])
	expect(requests.cspBlocked).toEqual([])
})
