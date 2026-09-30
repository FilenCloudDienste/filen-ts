import { useSecureStore } from "@/lib/secureStore"

export const PHOTOS_GRID_TILES_SECURE_STORE_KEY = "photosGridTiles"

export const DEFAULT_PHOTOS_GRID_TILES = 4

export function usePhotosGridTiles(): [number, (next: number | ((prev: number) => number)) => void] {
	return useSecureStore<number>(PHOTOS_GRID_TILES_SECURE_STORE_KEY, DEFAULT_PHOTOS_GRID_TILES)
}
