// Caps the page's routing (preview.logic) and the workers share, in a module light enough for both.

// Text viewers hold the file as a string (UTF-16, twice its bytes) plus the editor's own document model,
// and real text files are far smaller, so text, code, markdown and open-as-text stop lower still. A message's
// bodies stop here too.
export const TEXT_CAP = 33_554_432 // 32 MiB

// A message is parsed whole, its attachments held as Blobs beside it: real ones stay far below.
export const EMAIL_MAX_BYTES = 67_108_864 // 64 MiB
