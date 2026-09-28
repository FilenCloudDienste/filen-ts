import { fnv1a } from "@/lib/fnv1a"

// Generated playlist artwork. Playlists carry no cover of their own, and reading one from a track would
// mean downloading audio bytes just to paint a thumbnail, so the art is a pure function of the playlist
// uuid instead: stable across reloads, renames and edits, and free. A first track whose cover is already
// cached paints over it (PlaylistArtwork); nothing is ever read for the artwork alone. oklch at a mid
// lightness reads on both the light and the dark card.

// A CSS `background-image` value: two hues 40-119deg apart, so the pair never collapses into one flat
// color and never lands on its own complement (which muddies through the middle of the gradient).
export function playlistArtworkGradient(uuid: string): string {
	const hash = fnv1a(uuid)
	const from = hash % 360
	const to = (from + 40 + ((hash >>> 9) % 80)) % 360

	return `linear-gradient(135deg, oklch(0.72 0.15 ${String(from)}), oklch(0.52 0.17 ${String(to)}))`
}
