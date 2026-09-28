const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Where a long preview title splits into its truncating head and always-visible tail: `tailLength`
// UTF-16 units from the end, moved back to the start of the character there, so neither half carries
// a lone surrogate or a detached piece of an emoji sequence. 0 leaves the name whole.
export function previewTitleSplitIndex(name: string, tailLength: number): number {
	const at = name.length - tailLength

	if (at <= 0) {
		return 0
	}

	return graphemes.segment(name).containing(at)?.index ?? at
}
