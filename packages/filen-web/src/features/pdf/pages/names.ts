import type { TFunction } from "i18next"
import { formatPageRanges, type PageRange } from "@filen/office/core/pdfedit/pageRanges"
import { editedCopyName } from "@/features/drive/lib/copyName"

// Names of the PDFs extract and split make, in the drive's edited-copy convention (editedCopyName): the original's
// name with a suffix in parentheses, "report (pages 3-5).pdf", "report (part 1).pdf", the suffix numbered when the
// name is taken ("report (pages 3-5 2).pdf"). The suffix functions are what editedCopyName takes.

export type CopySuffix = (number: number) => string

function numbered(t: TFunction<"preview">, suffix: string): CopySuffix {
	return number => (number <= 1 ? suffix : t("previewPdfPagesSuffixNumbered", { suffix, number }))
}

// "pages 3-5", "page 3", "pages 1-2, 7".
export function extractSuffix(t: TFunction<"preview">, ranges: readonly PageRange[]): CopySuffix {
	const count = ranges.reduce((sum, range) => sum + range.last - range.first + 1, 0)

	return numbered(t, t("previewPdfPagesCopySuffix", { count, pages: formatPageRanges(ranges) }))
}

// "part 1".
export function partSuffix(t: TFunction<"preview">, part: number): CopySuffix {
	return numbered(t, t("previewPdfPagesPartSuffix", { part }))
}

// "without signatures": a signed PDF's copy whose pages can be organised.
export function unsignedSuffix(t: TFunction<"preview">): CopySuffix {
	return numbered(t, t("previewPdfPagesUnsignedSuffix"))
}

// One name per suffix, in order, each free in `taken` (lowercased names in the directory) and different from the
// names before it in the batch.
export function batchCopyNames(original: string, suffixes: readonly CopySuffix[], taken: ReadonlySet<string>): string[] {
	const used = new Set(taken)

	return suffixes.map(suffix => {
		const name = editedCopyName(original, "pdf", suffix, used)

		used.add(name.toLowerCase())

		return name
	})
}
