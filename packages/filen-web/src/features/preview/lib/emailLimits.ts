// A message is parsed whole, its attachments held as Blobs beside it: real ones stay far below. Its own module, so the
// page's routing and the worker's parser share it without either importing the other.
export const EMAIL_MAX_BYTES = 67_108_864 // 64 MiB
