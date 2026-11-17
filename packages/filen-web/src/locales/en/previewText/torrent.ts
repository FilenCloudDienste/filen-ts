// "preview" namespace, text family — a torrent file's metadata. Spread into preview.ts; same catalog rules.
export const previewTextTorrent = {
	/** Torrent preview — title when the torrent names nothing */
	previewTorrentUnnamed: "Unnamed torrent",
	/** Torrent preview — subtitle; {{version}} is previewTorrentVersion or previewTorrentVersionHybrid, {{count}} the number of files, {{size}} their total size */
	previewTorrentSummary_one: "{{version}} · {{count}} file · {{size}}",
	/** Torrent preview — subtitle; {{version}} is previewTorrentVersion or previewTorrentVersionHybrid, {{count}} the number of files, {{size}} their total size */
	previewTorrentSummary_other: "{{version}} · {{count}} files · {{size}}",
	/** Torrent preview — the BitTorrent protocol version the torrent is made for; {{version}} is 1 or 2 */
	previewTorrentVersion: "BitTorrent v{{version}}",
	/** Torrent preview — a torrent made for both protocol versions */
	previewTorrentVersionHybrid: "BitTorrent v1 + v2",
	/** Torrent preview — field label: the torrent's version 1 identifier (SHA-1) */
	previewTorrentInfohashV1: "Infohash v1",
	/** Torrent preview — field label: the torrent's version 2 identifier (SHA-256) */
	previewTorrentInfohashV2: "Infohash v2",
	/** Torrent preview — field label: a magnet link made from the torrent, to copy */
	previewTorrentMagnet: "Magnet link",
	/** Torrent preview — field label: the pieces the data is cut into */
	previewTorrentPieces: "Pieces",
	/** Torrent preview — pieces value; {{count}} is how many, {{size}} each one's size */
	previewTorrentPiecesValue_one: "{{count}} × {{size}}",
	/** Torrent preview — pieces value; {{count}} is how many, {{size}} each one's size */
	previewTorrentPiecesValue_other: "{{count}} × {{size}}",
	/** Torrent preview — field label: whether the torrent is private (no public peer discovery) */
	previewTorrentPrivate: "Private",
	/** Torrent preview — field value */
	previewTorrentYes: "Yes",
	/** Torrent preview — field value */
	previewTorrentNo: "No",
	/** Torrent preview — field label: when the torrent was made */
	previewTorrentCreated: "Created",
	/** Torrent preview — field label: the program that made the torrent */
	previewTorrentCreatedBy: "Created by",
	/** Torrent preview — field label: the torrent's own comment */
	previewTorrentComment: "Comment",
	/** Torrent preview — section title: tracker addresses listed in the file */
	previewTorrentTrackers: "Trackers",
	/** Torrent preview — section title: web servers listed in the file that hold the data */
	previewTorrentWebSeeds: "Web seeds",
	/** Torrent preview — accessible name of the table of the torrent's files */
	previewTorrentFiles: "Files",
	/** Torrent preview — files table column */
	previewTorrentFilePath: "Path",
	/** Torrent preview — files table column */
	previewTorrentFileSize: "Size",
	/** Torrent preview — footer: files beyond those listed; {{count}} is how many */
	previewTorrentFilesOmitted_one: "{{count}} more file is not listed.",
	/** Torrent preview — footer: files beyond those listed; {{count}} is how many */
	previewTorrentFilesOmitted_other: "{{count}} more files are not listed.",
	/** Torrent preview — footer: the preview read the file only */
	previewTorrentNotContacted: "Read from the file only: no tracker or peer was contacted.",
	/** Torrent preview — the file is not a torrent this preview can read */
	previewTorrentUnreadable: "This torrent file can't be read.",
	/** Torrent preview — reading the file failed (the reader stopped) */
	previewTorrentFailed: "This torrent file couldn't be read. Try again."
} as const
