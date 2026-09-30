import { useSecureStore } from "@/lib/secureStore"

export const PHOTOS_GRID_TILES_SECURE_STORE_KEY = "photosGridTiles"

export const DEFAULT_PHOTOS_GRID_TILES = 4

export const PHOTOS_GRID_TILE_OPTIONS = [1, 2, 3, 4, 5] as const

export function clampPhotosGridTiles(tiles: number): number {
	return Math.min(Math.max(PHOTOS_GRID_TILE_OPTIONS[0], tiles), PHOTOS_GRID_TILE_OPTIONS[4])
}

export function usePhotosGridTiles(): [number, (next: number | ((prev: number) => number)) => void] {
	return useSecureStore<number>(PHOTOS_GRID_TILES_SECURE_STORE_KEY, DEFAULT_PHOTOS_GRID_TILES)
}
