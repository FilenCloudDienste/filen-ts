import { scenarioModule } from "./scenarios"

// The RAR spec's archives (archive-rar.spec.ts), written by rars 0.12.4, the crate the SDK reads them with: a solid
// RAR 5 of four text pages (each page after the first is read after the ones before it) and a RAR 4 holding
// a directory, its members compressed. Inline: neither is 500 bytes.
//
// Recipe (in a scratch directory; the package is Apache-2.0):
//   npm pack @bitplane/rars@0.12.4 && tar xzf bitplane-rars-0.12.4.tgz
//   then, with RarWriter from package/node/index.js and every entry modified 2026-01-01T00:00:00Z:
//   - comic: new RarWriter({ format: "rar50", solid: true, level: 3 }), adding page-0N.txt (N = 1..4) holding
//     `comic page N\n` 40 times;
//   - store: new RarWriter({ format: "rar29", solid: false, level: 5 }), adding docs/readme.txt ("a RAR's readme\n"
//     32 times) and notes.txt ("notes stored in a RAR\n" 32 times), both compressed (LZ29), not stored;
//   each written with `await writer.bytes()` and base64-encoded below.

export const RAR_COMIC_PAGES = 4

export function rarComicPageText(page: number): string {
	return `comic page ${String(page)}\n`.repeat(40)
}

// The readme repeats this line.
export const RAR_README_LINE = "a RAR's readme"

const COMIC_CBR =
	"UmFyIRoHAQDc3l41AwEABCZbMqQRAwYcBBwABb2P7QAABFJBUlNyYXJzLzAuMTIuNAptYXJrZXItc2NoZW1hPTEKvEHD+UICAyMgBogEIAAAIVxlaJKsgAMAC3BhZ2UtMDEudHh0IgIAev0ESvQ+nmcvEZo2OLJcl3JZ9RwaMZE8AlOuEoPd1hrAhx0zAy+zL8RWQopCaEIcEM/0/kDe66T/aQqyxMPmAASclABCAgMjFAaIBCAAACFcZROucMADAAtwYWdlLTAyLnR4dCICAEBcDKWi+2tn+jykGRZrEYofiIrYzo9IRCr78gBhakZdwYoRAj/TEnz+dYAhi7j2E4BZfoDSc5ljQgIDIxQGiAQgAAAhXFo4lY3AAwALcGFnZS0wMy50eHQiAgCbGYWAoyh63kLUqlduoUvkKdlS0zbuGHT1kTmBb9Opu8GKEQI/0xKM/nOAIYu49hOAWX6AsLkLUUICAyMUBogEIAAAIVwk46cTwAMAC3BhZ2UtMDQudHh0IgIAgdPzN36UoDYFVWVFAdU+rTweDpk42sD/PyPNDGDjlyfBihECP9MSnP5xgCGLuPYTgFl+gBmyOjUDBQAA"

const STORE_RAR =
	"UmFyIRoHAM+QcwAADQAAAAAAAAACGnoAwCQAHAAAABwAAAAABb2P7QAAAAAdMAQAAAAAAFJBUlNyYXJzLzAuMTIuNAptYXJrZXItc2NoZW1hPTEKxjZ0IIAvAA8AAAAPAAAAAFYy4RUAACFcHTAPACAAAABkb2NzL3JlYWRtZS50eHRhIFJBUidzIHJlYWRtZQqACXQggCkAFgAAABYAAAAAFUmtMgAAIVwdMAkAIAAAAG5vdGVzLnR4dG5vdGVzIHN0b3JlZCBpbiBhIFJBUgo="

export const RAR_SCENARIOS = scenarioModule({ "archive-rar": ["e2e-rar-solid.rar", "e2e-rar-store.rar"] }, () => ({
	"e2e-rar-solid.rar": { buffer: Buffer.from(COMIC_CBR, "base64"), mimeType: "application/vnd.rar" },
	"e2e-rar-store.rar": { buffer: Buffer.from(STORE_RAR, "base64"), mimeType: "application/vnd.rar" }
}))
