//! Everything the JavaScript boundary needs, in safe Rust: the module owns its I/O buffers and callers pass
//! only lengths, which are checked here. The caller writes input into the scratch region (`buffer` gives its
//! address) and reads the result from the output region (`output`). The `wasm` module only forwards
//! exported functions to a `Boundary`; this one is plain Rust, so the host tests cover all of it.

#![forbid(unsafe_code)]

/// A length reaches past the scratch region.
pub const ERR_RANGE: i32 = -2;
/// The request exceeds the scratch cap or memory ran out.
pub const ERR_MEMORY: i32 = -5;

/// Callers send at most one MiB; the scratch region never grows past it.
pub const MAX_SCRATCH: usize = 1 << 20;

#[derive(Default)]
pub struct Boundary {
    // Zero-filled when grown: every byte is initialised whatever the caller writes or skips.
    scratch: Vec<u8>,
    output: Vec<u8>,
}

fn length(value: u32) -> usize {
    // u32 always fits usize on wasm32 and 64-bit hosts.
    usize::try_from(value).unwrap_or(usize::MAX)
}

impl Boundary {
    /// The scratch region with room for `min_len` bytes; `None` over the cap or out of memory.
    pub fn buffer(&mut self, min_len: u32) -> Option<usize> {
        let min_len = length(min_len);

        if min_len > MAX_SCRATCH {
            return None;
        }

        if self.scratch.len() < min_len {
            self.scratch
                .try_reserve_exact(min_len - self.scratch.len())
                .ok()?;
            self.scratch.resize(min_len, 0);
        }

        Some(self.scratch.as_ptr() as usize)
    }

    /// The output region's address.
    #[must_use]
    pub fn output(&self) -> usize {
        self.output.as_ptr() as usize
    }

    /// The scratch region's content, for tests.
    pub fn scratch_mut(&mut self) -> &mut [u8] {
        &mut self.scratch
    }

    /// The output region's content, for tests.
    #[must_use]
    pub fn output_bytes(&self) -> &[u8] {
        &self.output
    }

    /// Guesses the encoding of scratch `[0, len)`, writing its name to the output region; returns the name's
    /// byte length (0: no guess, the bytes hold no evidence) or an error.
    pub fn guess(&mut self, len: u32, last: bool) -> i32 {
        let Some(bytes) = self.scratch.get(..length(len)) else {
            return ERR_RANGE;
        };

        self.output.clear();

        if let Some(name) = crate::guess(bytes, last) {
            self.output.extend_from_slice(name.as_bytes());
        }

        i32::try_from(self.output.len()).unwrap_or(ERR_MEMORY)
    }
}

#[cfg(test)]
mod tests {
    use super::{Boundary, ERR_RANGE, MAX_SCRATCH};

    #[test]
    fn guesses_what_the_scratch_holds() {
        let mut boundary = Boundary::default();
        let (bytes, _, _) = encoding_rs::WINDOWS_1251
            .encode("Съешь же ещё этих мягких французских булок, да выпей чаю.");
        let len = u32::try_from(bytes.len()).unwrap();

        assert!(boundary.buffer(len).is_some());
        boundary.scratch_mut()[..bytes.len()].copy_from_slice(&bytes);

        let written = boundary.guess(len, true);

        assert_eq!(
            &boundary.output_bytes()[..usize::try_from(written).unwrap()],
            b"windows-1251"
        );
    }

    #[test]
    fn has_no_guess_for_ascii() {
        let mut boundary = Boundary::default();
        let bytes = b"plain ascii";
        let len = u32::try_from(bytes.len()).unwrap();

        assert!(boundary.buffer(len).is_some());
        boundary.scratch_mut()[..bytes.len()].copy_from_slice(bytes);

        assert_eq!(boundary.guess(len, true), 0);
        assert!(boundary.output_bytes().is_empty());
    }

    #[test]
    fn refuses_a_length_past_the_scratch() {
        let mut boundary = Boundary::default();

        assert!(boundary.buffer(4).is_some());
        assert_eq!(boundary.guess(5, true), ERR_RANGE);
    }

    #[test]
    fn caps_the_scratch() {
        let mut boundary = Boundary::default();
        let cap = u32::try_from(MAX_SCRATCH).unwrap();

        assert!(boundary.buffer(cap).is_some());
        assert!(boundary.buffer(cap + 1).is_none());
    }
}
