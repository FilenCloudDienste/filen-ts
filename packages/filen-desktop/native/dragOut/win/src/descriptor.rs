//! The `FileGroupDescriptorW` Explorer reads at the drop: a `u32` count, then one 592-byte `FILEDESCRIPTORW` per entry
//! (`shlobj_core.h`), built once per drag from the planned entries. Byte offsets are spelled out so the layout is
//! checked on every host; the Windows tests compare it with the SDK's struct.

use core::fmt;

/// Explorer's descriptor cap the planner already applies (`WINDOWS_LIMITS.maxEntries`), checked again here.
pub const MAX_ENTRIES: usize = 10_000;
/// `cFileName` holds `MAX_PATH` (260) units including the terminating NUL.
pub const MAX_PATH_UNITS: usize = 259;
/// `size_of::<FILEDESCRIPTORW>()`.
pub const DESCRIPTOR_SIZE: usize = 592;

pub const FD_ATTRIBUTES: u32 = 0x0000_0004;
pub const FD_WRITESTIME: u32 = 0x0000_0020;
pub const FD_FILESIZE: u32 = 0x0000_0040;
pub const FD_PROGRESSUI: u32 = 0x0000_4000;
pub const FD_UNICODE: u32 = 0x8000_0000;
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;

// Field offsets inside one FILEDESCRIPTORW.
pub const OFFSET_FLAGS: usize = 0;
pub const OFFSET_ATTRIBUTES: usize = 36;
pub const OFFSET_WRITE_TIME: usize = 56;
pub const OFFSET_SIZE_HIGH: usize = 64;
pub const OFFSET_SIZE_LOW: usize = 68;
pub const OFFSET_NAME: usize = 72;

/// 100 ns intervals between 1601-01-01 (`FILETIME`'s epoch) and 1970-01-01.
const UNIX_EPOCH_FILETIME: f64 = 116_444_736_000_000_000.0;

/// One planned entry: a `\`-separated path relative to the drop directory.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub path: String,
    pub directory: bool,
    pub size: u64,
    pub mtime_ms: Option<f64>,
}

impl Entry {
    /// The last path segment.
    #[must_use]
    pub fn name(&self) -> &str {
        self.path.rsplit('\\').next().unwrap_or(&self.path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DescriptorError {
    NoEntries,
    TooMany(usize),
    PathTooLong(String),
    InvalidPath(String),
}

impl fmt::Display for DescriptorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoEntries => write!(f, "no entries"),
            Self::TooMany(count) => write!(f, "{count} entries, more than {MAX_ENTRIES}"),
            Self::PathTooLong(path) => {
                write!(f, "path longer than {MAX_PATH_UNITS} UTF-16 units: {path}")
            }
            Self::InvalidPath(path) => write!(f, "not a relative path: {path}"),
        }
    }
}

impl std::error::Error for DescriptorError {}

/// Unix milliseconds as a `FILETIME` value; None before 1601, past `FILETIME`'s range or not finite.
#[must_use]
// The cast is used only after the range check: a whole number in 0..i64::MAX.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn filetime(ms: f64) -> Option<u64> {
    let ticks = ms.mul_add(10_000.0, UNIX_EPOCH_FILETIME).round();
    #[allow(clippy::cast_precision_loss)]
    let max = i64::MAX as f64;

    (0.0..max).contains(&ticks).then_some(ticks as u64)
}

/// The entry's `dwFlags`: every entry names its attributes, size and Unicode path and asks for Explorer's progress
/// dialog; the write time only when the entry has one.
#[must_use]
pub fn flags(entry: &Entry) -> u32 {
    let base = FD_ATTRIBUTES | FD_FILESIZE | FD_PROGRESSUI | FD_UNICODE;

    if entry.mtime_ms.and_then(filetime).is_some() {
        base | FD_WRITESTIME
    } else {
        base
    }
}

fn check_path(path: &str) -> Result<(), DescriptorError> {
    let invalid = path.is_empty()
        || path.contains(['/', ':', '\0'])
        || path
            .split('\\')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..");

    if invalid {
        return Err(DescriptorError::InvalidPath(path.to_owned()));
    }

    if path.encode_utf16().count() > MAX_PATH_UNITS {
        return Err(DescriptorError::PathTooLong(path.to_owned()));
    }

    Ok(())
}

fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

/// The whole `FileGroupDescriptorW` medium.
///
/// # Errors
/// No entries, more than [`MAX_ENTRIES`], or a path that is empty, absolute, has an empty, `.` or `..` segment, a
/// `/`, `:` or NUL, or more than [`MAX_PATH_UNITS`] UTF-16 units.
pub fn build(entries: &[Entry]) -> Result<Vec<u8>, DescriptorError> {
    if entries.is_empty() {
        return Err(DescriptorError::NoEntries);
    }

    let count = u32::try_from(entries.len())
        .ok()
        .filter(|_| entries.len() <= MAX_ENTRIES)
        .ok_or(DescriptorError::TooMany(entries.len()))?;
    let mut bytes = vec![0u8; 4 + DESCRIPTOR_SIZE * entries.len()];
    put_u32(&mut bytes, 0, count);

    for (index, entry) in entries.iter().enumerate() {
        check_path(&entry.path)?;

        let at = 4 + index * DESCRIPTOR_SIZE;
        let size = if entry.directory { 0 } else { entry.size };
        let attributes = if entry.directory {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };

        put_u32(&mut bytes, at + OFFSET_FLAGS, flags(entry));
        put_u32(&mut bytes, at + OFFSET_ATTRIBUTES, attributes);
        if let Some(time) = entry.mtime_ms.and_then(filetime) {
            bytes[at + OFFSET_WRITE_TIME..at + OFFSET_WRITE_TIME + 8]
                .copy_from_slice(&time.to_le_bytes());
        }
        put_u32(&mut bytes, at + OFFSET_SIZE_HIGH, (size >> 32) as u32);
        // The low half of the size, by definition.
        #[allow(clippy::cast_possible_truncation)]
        put_u32(&mut bytes, at + OFFSET_SIZE_LOW, size as u32);
        for (unit, value) in entry.path.encode_utf16().enumerate() {
            let offset = at + OFFSET_NAME + unit * 2;
            bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        }
    }

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, size: u64, mtime_ms: Option<f64>) -> Entry {
        Entry {
            path: path.to_owned(),
            directory: false,
            size,
            mtime_ms,
        }
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"))
    }

    fn u64_at(bytes: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8 bytes"))
    }

    fn name_at(bytes: &[u8], at: usize) -> Vec<u16> {
        bytes[at..at + 520]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect()
    }

    #[test]
    fn descriptor_bytes_follow_the_shell_layout() {
        let size = (5u64 << 32) | 7;
        let entries = [
            Entry {
                path: "dir".to_owned(),
                directory: true,
                size: 99,
                mtime_ms: None,
            },
            file("dir\\a.txt", size, None),
        ];
        let bytes = build(&entries).expect("valid entries");

        assert_eq!(bytes.len(), 4 + 2 * DESCRIPTOR_SIZE);
        assert_eq!(u32_at(&bytes, 0), 2);

        let dir = 4;
        assert_eq!(
            u32_at(&bytes, dir + OFFSET_FLAGS),
            FD_ATTRIBUTES | FD_FILESIZE | FD_PROGRESSUI | FD_UNICODE
        );
        assert_eq!(
            u32_at(&bytes, dir + OFFSET_ATTRIBUTES),
            FILE_ATTRIBUTE_DIRECTORY
        );
        assert_eq!(u32_at(&bytes, dir + OFFSET_SIZE_HIGH), 0);
        assert_eq!(u32_at(&bytes, dir + OFFSET_SIZE_LOW), 0);

        let entry = 4 + DESCRIPTOR_SIZE;
        assert_eq!(
            u32_at(&bytes, entry + OFFSET_ATTRIBUTES),
            FILE_ATTRIBUTE_NORMAL
        );
        assert_eq!(u32_at(&bytes, entry + OFFSET_SIZE_HIGH), 5);
        assert_eq!(u32_at(&bytes, entry + OFFSET_SIZE_LOW), 7);
        let name = name_at(&bytes, entry + OFFSET_NAME);
        let want: Vec<u16> = "dir\\a.txt".encode_utf16().collect();
        assert_eq!(&name[..want.len()], want.as_slice());
        assert!(name[want.len()..].iter().all(|unit| *unit == 0));
        // Everything but flags, attributes, the write time, size and name stays zero (clsid, sizel, pointl, times).
        assert!(
            bytes[entry + 4..entry + OFFSET_ATTRIBUTES]
                .iter()
                .all(|b| *b == 0)
        );
        assert!(
            bytes[entry + 40..entry + OFFSET_SIZE_HIGH]
                .iter()
                .all(|b| *b == 0)
        );
    }

    #[test]
    fn write_time_is_set_only_with_an_mtime() {
        let bytes =
            build(&[file("a", 1, Some(1_000.0)), file("b", 1, None)]).expect("valid entries");
        let first = 4;
        let second = 4 + DESCRIPTOR_SIZE;

        assert_ne!(u32_at(&bytes, first + OFFSET_FLAGS) & FD_WRITESTIME, 0);
        assert_eq!(
            u64_at(&bytes, first + OFFSET_WRITE_TIME),
            116_444_736_010_000_000
        );
        assert_eq!(u32_at(&bytes, second + OFFSET_FLAGS) & FD_WRITESTIME, 0);
        assert_eq!(u64_at(&bytes, second + OFFSET_WRITE_TIME), 0);
    }

    #[test]
    fn an_mtime_outside_filetime_is_left_out() {
        assert_eq!(filetime(0.0), Some(116_444_736_000_000_000));
        assert_eq!(filetime(-11_644_473_600_000.0), Some(0));
        assert_eq!(filetime(-11_644_473_600_001.0), None);
        assert_eq!(filetime(f64::NAN), None);
        assert_eq!(filetime(f64::INFINITY), None);
        assert_eq!(filetime(1e300), None);
        assert_eq!(flags(&file("a", 0, Some(f64::NAN))) & FD_WRITESTIME, 0);
    }

    #[test]
    fn a_260_unit_path_is_rejected() {
        let ok = "a".repeat(MAX_PATH_UNITS);
        let long = "a".repeat(MAX_PATH_UNITS + 1);

        assert!(build(&[file(&ok, 0, None)]).is_ok());
        assert_eq!(
            build(&[file(&long, 0, None)]),
            Err(DescriptorError::PathTooLong(long))
        );
    }

    #[test]
    fn path_length_counts_utf16_units() {
        // U+1F600 is two UTF-16 units.
        let ok = "\u{1F600}".repeat(129) + "a";
        let long = "\u{1F600}".repeat(130);

        assert!(build(&[file(&ok, 0, None)]).is_ok());
        assert!(matches!(
            build(&[file(&long, 0, None)]),
            Err(DescriptorError::PathTooLong(_))
        ));
    }

    #[test]
    fn rejects_paths_that_leave_the_drop_directory() {
        for path in [
            "", "\\a", "a\\", "a\\\\b", ".", "a\\..", "..\\a", "a/b", "C:a", "a\0b",
        ] {
            assert_eq!(
                build(&[file(path, 0, None)]),
                Err(DescriptorError::InvalidPath(path.to_owned())),
                "{path:?}"
            );
        }
        assert!(build(&[file("a\\.b\\..c", 0, None)]).is_ok());
    }

    #[test]
    fn rejects_no_entries_and_past_the_cap() {
        assert_eq!(build(&[]), Err(DescriptorError::NoEntries));
        let many = vec![file("a", 0, None); MAX_ENTRIES + 1];
        assert_eq!(build(&many), Err(DescriptorError::TooMany(MAX_ENTRIES + 1)));
        assert!(build(&many[..MAX_ENTRIES]).is_ok());
    }

    #[test]
    fn the_name_is_the_last_segment() {
        assert_eq!(file("a\\b\\c.txt", 0, None).name(), "c.txt");
        assert_eq!(file("c.txt", 0, None).name(), "c.txt");
    }
}
