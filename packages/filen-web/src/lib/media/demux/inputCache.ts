import type { Input } from "mediabunny"
import type { BlockCache } from "@/lib/media/blockCache"

// The block cache under each input openBlockInput opened, for a demuxer that must read past it
// (BlockCache.readThrough): an AVI's idx1, read once, would otherwise evict the blocks playback is using.
const CACHES = new WeakMap<Input, BlockCache>()

export function registerBlockCache(input: Input, cache: BlockCache): void {
	CACHES.set(input, cache)
}

export function blockCacheOf(input: Input): BlockCache | null {
	return CACHES.get(input) ?? null
}
