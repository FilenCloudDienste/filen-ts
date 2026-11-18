import { crc32, deflateSync } from "node:zlib"
import { buildTar, buildZip, prng, ZIPCRYPTO_PASSWORD } from "../helpers/archiveFixtures"
import { scenarioModule } from "./scenarios"

// The comic reader's books (comics.spec.ts): four PNG pages each, of four greys, 6×9 pixels (portrait), in a zip, in a
// bare tar padded past the 8 MiB listing gate, and in a solid RAR 5, whose pages after the first are read after the
// ones stored before them.
//
// The RAR's recipe (in a scratch directory; the package is Apache-2.0): npm pack @bitplane/rars@0.12.4, then with
// RarWriter from package/node/index.js, new RarWriter({ format: "rar50", solid: true, level: 3 }), adding p0N.png
// (N = 1..4, comicPagePng(N)) modified 2026-01-01T00:00:00Z, written with `await writer.bytes()`, base64-encoded below.

export const COMIC_PAGES = 4

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	const body = Buffer.concat([Buffer.from(type, "latin1"), data])
	const crc = Buffer.alloc(4)

	length.writeUInt32BE(data.length)
	crc.writeUInt32BE(crc32(body) >>> 0)

	return Buffer.concat([length, body, crc])
}

// Page `page` (from 1): a 6×9 RGB PNG of one grey.
export function comicPagePng(page: number): Buffer {
	const width = 6
	const height = 9
	const header = Buffer.alloc(13)

	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8
	header[9] = 2

	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 40 * page)])

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(Buffer.concat(new Array<Buffer>(height).fill(row)), { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0))
	])
}

function pages(): { name: string; data: Buffer }[] {
	return Array.from({ length: COMIC_PAGES }, (_, i) => ({ name: `p0${String(i + 1)}.png`, data: comicPagePng(i + 1) }))
}

// Past UNGATED_MAX_BYTES, so its listing waits for "Read".
const CBT_PADDING_BYTES = 9 * 1024 * 1024

const COMIC_CBR =
	"UmFyIRoHAQDc3l41AwEABCZbMqQRAwYcBBwABb2P7QAABFJBUlNyYXJzLzAuMTIuNAptYXJrZXItc2NoZW1hPTEKC13o/D0CAyNYBkggAAAhXBqkhAmAAwAHcDAxLnBuZyICAAG5TmX0IkCDATxTg7NzYgHFfyOzyOIxZA496KZMSAV1wM9VNVAEH5M/xQh0dFSgxsnIdT0E6tSkYK6RcVMJYIwZd1S5iTBGPev9lPpPZbxcyxKKEAJXarACECOKADn57wJVqpbr7n52SbtiHYz36Om/xdbFdVZbAMba0n89AgMjJgZIIAAAIVyGfUR5wAMAB3AwMi5wbmciAgCCsQ5TtW+tfrlqAb+D5E+sAs/7qx0m0HJnBhY+5GMxOcO6IzMDL7MvSQTBIK4Rwhd9l7kZkTkfUBVRe6grxUvFaZXp4fjgmKg24z0CAyMlBkggAAAhXPcf/KrAAwAHcDAzLnBuZyICAGDolMLQvOlXDslTEX8fkRIwHf2w9luOr1AG9UrgGa2BwbkiAwM/sxQMD4Z26wlhK8UboLQmh8AIUTuAU4gvFfazSztDgG4+nTc9AgMjLgZIIAAAIVxZV+GywAMAB3AwNC5wbmciAgAUdQ2mq49ogvUyMfh/boZ3krCTnrCeF/Y5t0RxvEe8EMOyKwMAI/oi/T3dhHSFiRhABgKI6R4gpEiEkP0A0oy83N0X1Uo6Hp/ynQbNWyAZsjo1AwUAAA=="

export const COMIC_SCENARIOS = scenarioModule(
	{
		comics: ["e2e-comic.cbz", "e2e-comic.cbr", "e2e-comic.cbt"],
		// The same pages under ZipCrypto (ZIPCRYPTO_PASSWORD): every page read is checked, so a wrong password never shows.
		"comics-locked": ["e2e-comic-locked.cbz"]
	},
	() => ({
		"e2e-comic.cbz": { buffer: buildZip(pages()), mimeType: "application/vnd.comicbook+zip" },
		"e2e-comic.cbr": { buffer: Buffer.from(COMIC_CBR, "base64"), mimeType: "application/vnd.comicbook-rar" },
		// The pages first, then incompressible padding the reader never shows (not an image).
		"e2e-comic.cbt": { generate: () => buildTar([...pages(), { name: "padding.bin", data: prng(0xc0b1c)(CBT_PADDING_BYTES) }]) },
		"e2e-comic-locked.cbz": {
			buffer: buildZip(pages().map(page => ({ ...page, zipCrypto: ZIPCRYPTO_PASSWORD }))),
			mimeType: "application/vnd.comicbook+zip"
		}
	})
)
