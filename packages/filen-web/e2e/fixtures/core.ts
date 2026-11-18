import { DOCX_MIME, docxFixtureBytes, docxViewerBytes, largePictureBytes, svgPictureBytes, webpPictureBytes } from "../helpers/docxFixtures"
import {
	BMP_BYTES,
	CODE_BYTES,
	DOCX_BYTES,
	DOWNLOAD_CANCEL_BYTES,
	DOWNLOAD_FSA_TEXT,
	DOWNLOAD_SW_TEXT,
	DOWNLOAD_ZIP_A_TEXT,
	DOWNLOAD_ZIP_B_TEXT,
	HEIC_BYTES,
	MP3_BYTES,
	MP4_BYTES,
	PDF_BYTES,
	PDF_LINKS_BYTES,
	PDF_PASSWORD_BYTES,
	PNG_BYTES
} from "../helpers/fixtureBytes"
import {
	bulkZip,
	corruptTarGz,
	dialogZip,
	emptyZip,
	garbageZip,
	gateBigTarGz,
	gateNextZip,
	gateStopTarGz,
	hostileZip,
	hundredKZip,
	linksTar,
	lockedZip,
	manyLinksZip,
	noteTxtGz,
	smallTarGz,
	treeZip
} from "../helpers/archiveFixtures"
import { scenarioModule } from "./scenarios"

// The tree's first scenarios, from before the scenario modules: the listing, preview, download, archive
// and DOCX specs' files.
export const CORE_SCENARIOS = scenarioModule(
	{
		// Six rows for the rubber-band drags, asserted as toHaveCount(6). Zero-padded-free single digits
		// keep the nameAsc order identical to the index order the test selects by.
		marquee: ["marquee-0.txt", "marquee-1.txt", "marquee-2.txt", "marquee-3.txt", "marquee-4.txt", "marquee-5.txt"],
		// Exactly two slots: the overlay pager steps a -> b and back.
		"preview-image": ["preview-image-a.png", "preview-image-b.png"],
		"preview-heic": ["preview-heic.heic"],
		// Two independent PDFs opened in turn — the multi-page/text-layer one, then the annotation-link one.
		"preview-pdf-pages": ["preview-pdf.pdf", "preview-pdf-links.pdf"],
		"preview-pdf-locked": ["preview-pdf-locked.pdf"],
		// One shared base name so nameAsc puts the VIDEO at the middle pager index (mp3 < mp4 < png) —
		// preview-media.spec.ts's ArrowRight leg is only meaningful with Next actually enabled.
		"preview-media": ["preview-media.mp3", "preview-media.mp4", "preview-media.png"],
		"preview-docx": ["preview-docx.docx"],
		"preview-code": ["preview-code.ts"],
		// png + bmp + svg all thumbnail; txt must keep its file-type icon.
		thumbnails: ["thumbnails.png", "thumbnails.bmp", "thumbnails.txt", "thumbnails.svg"],
		"download-fsa": ["download-fsa.txt"],
		"download-zip": ["download-zip-a.txt", "download-zip-b.txt"],
		"download-sw": ["download-sw.txt"],
		"download-cancel": ["download-cancel.bin"],
		// The archive browser's read-only subjects (helpers/archiveFixtures.ts builds each). Name order is
		// the overlay pager's order, which the keyboard and entry-point legs step through. Every archive is
		// named "e2e-…": an extract of one may be trashed, and its directory takes the archive's base name.
		"archive-browse": [
			"e2e-arc-corrupt.tar.gz",
			"e2e-arc-empty.zip",
			"e2e-arc-garbage.zip",
			"e2e-arc-hostile.zip",
			"e2e-arc-links.tar",
			"e2e-arc-locked.zip",
			"e2e-arc-note.txt.gz",
			"e2e-arc-small.tar.gz",
			"e2e-arc-tree.zip"
		],
		// The gate pair: the big tarball lists only on "Browse contents", the zip after it at once.
		"archive-gate": ["e2e-arc-gate-big.tar.gz", "e2e-arc-gate-next.zip"],
		// A gated tarball whose first members are small, for a listing stopped mid-read.
		"archive-gate-stop": ["e2e-arc-gate-stop.tar.gz"],
		"archive-report": ["e2e-arc-many-links.zip"],
		"archive-huge": ["e2e-arc-100k.zip"],
		"archive-bulk": ["e2e-bulk-a.zip", "e2e-bulk-b.zip", "e2e-bulk-c.zip"],
		// Text files for the compress dialog's naming, and one zip for a mixed archive + file selection.
		"archive-dialogs": ["dialog-a.txt", "dialog-b.txt", "dialog-c.zip"],
		// The DOCX editing specs' documents and pictures (helpers/docxFixtures.ts). The pictures are synthesized on disk,
		// so they are a scenario of their own.
		"docx-edit": [
			"w3-comments.docx",
			"w3-equations.docx",
			"w3-forms.docx",
			"w3-headers.docx",
			"w3-rtl-table.docx",
			"w3-tables.docx",
			"w3-toc.docx",
			"w3-tracked.docx"
		],
		"docx-pictures": ["w3-picture-large.png", "w3-picture.svg", "w3-picture.webp"],
		// The editor's notes and a picture (handles), for the IME, accessibility and touch specs.
		"docx-notes-picture": ["notes.docx", "described-picture.docx"],
		// The viewer's subjects (helpers/docxFixtures.ts): name order is the overlay pager's. The viewer documents a drive
		// preview would open in the editor are entries of the zip.
		"docx-viewer": ["viewer-archive.7z", "viewer-archive.zip", "viewer-encrypted.docx", "viewer-legacy.docx", "viewer-malformed.docx"]
	},
	() => ({
		"marquee-0.txt": { buffer: Buffer.from("marquee probe 0"), mimeType: "text/plain" },
		"marquee-1.txt": { buffer: Buffer.from("marquee probe 1"), mimeType: "text/plain" },
		"marquee-2.txt": { buffer: Buffer.from("marquee probe 2"), mimeType: "text/plain" },
		"marquee-3.txt": { buffer: Buffer.from("marquee probe 3"), mimeType: "text/plain" },
		"marquee-4.txt": { buffer: Buffer.from("marquee probe 4"), mimeType: "text/plain" },
		"marquee-5.txt": { buffer: Buffer.from("marquee probe 5"), mimeType: "text/plain" },
		"preview-image-a.png": { buffer: PNG_BYTES, mimeType: "image/png" },
		"preview-image-b.png": { buffer: PNG_BYTES, mimeType: "image/png" },
		"preview-heic.heic": { buffer: HEIC_BYTES, mimeType: "image/heic" },
		"preview-pdf.pdf": { buffer: PDF_BYTES, mimeType: "application/pdf" },
		"preview-pdf-links.pdf": { buffer: PDF_LINKS_BYTES, mimeType: "application/pdf" },
		"preview-pdf-locked.pdf": { buffer: PDF_PASSWORD_BYTES, mimeType: "application/pdf" },
		"preview-media.mp3": { buffer: MP3_BYTES, mimeType: "audio/mpeg" },
		"preview-media.mp4": { buffer: MP4_BYTES, mimeType: "video/mp4" },
		"preview-media.png": { buffer: PNG_BYTES, mimeType: "image/png" },
		"preview-docx.docx": {
			buffer: DOCX_BYTES,
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		},
		// video/mp2t is what a browser reports for a .ts file — kept verbatim so the code-preview leg still
		// proves the app routes by EXTENSION and not by the picker's own content-type guess.
		"preview-code.ts": { buffer: CODE_BYTES, mimeType: "video/mp2t" },
		"thumbnails.png": { buffer: PNG_BYTES, mimeType: "image/png" },
		"thumbnails.bmp": { buffer: BMP_BYTES, mimeType: "image/bmp" },
		"thumbnails.txt": { buffer: Buffer.from("not an image", "utf8"), mimeType: "text/plain" },
		"thumbnails.svg": {
			buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8"),
			mimeType: "image/svg+xml"
		},
		"download-fsa.txt": { buffer: Buffer.from(DOWNLOAD_FSA_TEXT, "utf8"), mimeType: "text/plain" },
		"download-zip-a.txt": { buffer: Buffer.from(DOWNLOAD_ZIP_A_TEXT, "utf8"), mimeType: "text/plain" },
		"download-zip-b.txt": { buffer: Buffer.from(DOWNLOAD_ZIP_B_TEXT, "utf8"), mimeType: "text/plain" },
		"download-sw.txt": { buffer: Buffer.from(DOWNLOAD_SW_TEXT, "utf8"), mimeType: "text/plain" },
		"download-cancel.bin": { filledBytes: DOWNLOAD_CANCEL_BYTES },
		"e2e-arc-corrupt.tar.gz": { buffer: corruptTarGz(), mimeType: "application/gzip" },
		"e2e-arc-empty.zip": { buffer: emptyZip(), mimeType: "application/zip" },
		"e2e-arc-garbage.zip": { buffer: garbageZip(), mimeType: "application/zip" },
		"e2e-arc-hostile.zip": { buffer: hostileZip(), mimeType: "application/zip" },
		"e2e-arc-links.tar": { buffer: linksTar(), mimeType: "application/x-tar" },
		"e2e-arc-locked.zip": { buffer: lockedZip(), mimeType: "application/zip" },
		"e2e-arc-note.txt.gz": { buffer: noteTxtGz(), mimeType: "application/gzip" },
		"e2e-arc-small.tar.gz": { buffer: smallTarGz(), mimeType: "application/gzip" },
		"e2e-arc-tree.zip": { buffer: treeZip(), mimeType: "application/zip" },
		// 8.5 MiB and 9 MB: off disk, like download-cancel.bin.
		"e2e-arc-gate-big.tar.gz": { generate: gateBigTarGz },
		"e2e-arc-gate-next.zip": { generate: gateNextZip },
		"e2e-arc-gate-stop.tar.gz": { generate: gateStopTarGz },
		"e2e-arc-many-links.zip": { buffer: manyLinksZip(), mimeType: "application/zip" },
		"e2e-arc-100k.zip": { generate: hundredKZip },
		"e2e-bulk-a.zip": { buffer: bulkZip("a"), mimeType: "application/zip" },
		"e2e-bulk-b.zip": { buffer: bulkZip("b"), mimeType: "application/zip" },
		"e2e-bulk-c.zip": { buffer: bulkZip("c"), mimeType: "application/zip" },
		"dialog-a.txt": { buffer: Buffer.from("dialog probe a", "utf8"), mimeType: "text/plain" },
		"dialog-b.txt": { buffer: Buffer.from("dialog probe b", "utf8"), mimeType: "text/plain" },
		"dialog-c.zip": { buffer: dialogZip(), mimeType: "application/zip" },
		"w3-comments.docx": { buffer: docxFixtureBytes("w3-comments.docx"), mimeType: DOCX_MIME },
		"w3-equations.docx": { buffer: docxFixtureBytes("w3-equations.docx"), mimeType: DOCX_MIME },
		"w3-forms.docx": { buffer: docxFixtureBytes("w3-forms.docx"), mimeType: DOCX_MIME },
		"w3-headers.docx": { buffer: docxFixtureBytes("w3-headers.docx"), mimeType: DOCX_MIME },
		"w3-rtl-table.docx": { buffer: docxFixtureBytes("w3-rtl-table.docx"), mimeType: DOCX_MIME },
		"w3-tables.docx": { buffer: docxFixtureBytes("w3-tables.docx"), mimeType: DOCX_MIME },
		"w3-toc.docx": { buffer: docxFixtureBytes("w3-toc.docx"), mimeType: DOCX_MIME },
		"w3-tracked.docx": { buffer: docxFixtureBytes("w3-tracked.docx"), mimeType: DOCX_MIME },
		// ~27 MB: off disk, like download-cancel.bin (so the scenario's other pictures are too).
		"w3-picture-large.png": { generate: largePictureBytes },
		"w3-picture.svg": { generate: svgPictureBytes },
		"w3-picture.webp": { generate: webpPictureBytes },
		"notes.docx": { buffer: docxFixtureBytes("notes.docx"), mimeType: DOCX_MIME },
		"described-picture.docx": { buffer: docxFixtureBytes("described-picture.docx"), mimeType: DOCX_MIME },
		"viewer-archive.7z": { buffer: docxViewerBytes("viewer-archive.7z"), mimeType: "application/x-7z-compressed" },
		"viewer-archive.zip": { buffer: docxViewerBytes("viewer-archive.zip"), mimeType: "application/zip" },
		"viewer-encrypted.docx": { buffer: docxViewerBytes("viewer-encrypted.docx"), mimeType: DOCX_MIME },
		"viewer-legacy.docx": { buffer: docxViewerBytes("viewer-legacy.docx"), mimeType: DOCX_MIME },
		"viewer-malformed.docx": { buffer: docxViewerBytes("viewer-malformed.docx"), mimeType: DOCX_MIME }
	})
)
