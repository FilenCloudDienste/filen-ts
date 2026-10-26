import { describe, expect, it } from "vitest"
import { redact } from "../main/redact.ts"

describe("redact", () => {
	it.each([
		["webdav://alice:hunter2@127.0.0.1:8080/", "webdav://[redacted]@127.0.0.1:8080/"],
		["fetch with Bearer abc.def-ghi", "fetch with Bearer [redacted]"],
		["Authorization: Bearer abc.def-ghi", "Authorization: [redacted] [redacted]"],
		[
			"rclone serve webdav --user filen --pass s3cr3t --addr 127.0.0.1",
			"rclone serve webdav --user filen --pass [redacted] --addr 127.0.0.1"
		],
		["--password=s3cr3t --s3-secret-access-key KEY", "--password=[redacted] --s3-secret-access-key [redacted]"],
		['{"apiKey":"abc","authVersion":2}', '{"apiKey":[redacted],"authVersion":2}'],
		['{"masterKeys":"a|b","privateKey":"-----BEGIN"}', '{"masterKeys":[redacted],"privateKey":[redacted]}'],
		["token=abc123&next=1", "token=[redacted]&next=1"],
		["jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl end", "jwt [redacted] end"],
		[`key ${"a1".repeat(32)} end`, "key [redacted] end"]
	])("%s", (input, output) => {
		expect(redact(input)).toBe(output)
	})

	it("keeps ordinary diagnostics", () => {
		const line =
			"session vault could not be decrypted: ENOENT /Users/someone/Library/Application Support/@filen/desktop 550e8400-e29b-41d4-a716-446655440000"

		expect(redact(line)).toBe(line)
		expect(redact("--addr 127.0.0.1 --read-only")).toBe("--addr 127.0.0.1 --read-only")
		expect(redact("a-very-long-hyphenated-file-name-without-any-digits-at-all.txt")).toBe(
			"a-very-long-hyphenated-file-name-without-any-digits-at-all.txt"
		)
	})

	it("is stable on its own output", () => {
		const once = redact('{"apiKey":"abc"} --pass x')

		expect(redact(once)).toBe(once)
	})
})
