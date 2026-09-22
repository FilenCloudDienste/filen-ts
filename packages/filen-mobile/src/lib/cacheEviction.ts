// Byte caps for the on-disk caches (fileCache, audioCache, rawPreviewCache) — the eviction
// planner itself (planSizeCapEviction) now lives in @filen/shared; these budgets stay app-side
// since they're mobile-specific disk allowances, not shared behavior.

// 250MB — parity with Android's Glide default disk-cache cap (expo-image's iOS
// SDWebImage store is otherwise only age-bounded at 1 week, hence the buildup).
export const CACHE_MAX_SIZE_BYTES = 250 * 1024 * 1024

// 128MB for the RAW preview cache (rawPreviewCache.ts): a full-size embedded JPEG is 2–25 MB, so
// this keeps roughly the last dozen opened RAW shots — a browsing session, not an archive.
export const RAW_PREVIEW_CACHE_MAX_SIZE_BYTES = 128 * 1024 * 1024
