//! One explicitly prepared drag capture. No Cocoa, clock, serialization or I/O.
//!
//! `poll` and `finish_html` are the only resolution points. A paired reply owns
//! the paths exactly once; diagnostics must never be treated as authorization.
use std::collections::HashSet;

pub const PREPARED_TTL_MS: u64 = 30_000;
pub const DELIVERY_TTL_MS: u64 = 1_000;
const MAX_CAPTURE_IDS: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Armed,
    Pending,
    Paired,
    Consumed,
    Ambiguous,
    Unmatched,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Armed => "armed",
            Self::Pending => "pending",
            Self::Paired => "paired",
            Self::Consumed => "consumed",
            Self::Ambiguous => "ambiguous",
            Self::Unmatched => "unmatched",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub phase: Phase,
    pub generation: u64,
    pub capture_id: String,
    pub native_drop_id: Option<u64>,
    pub sequence: Option<i64>,
    pub html_drop_id: Option<String>,
    pub native_count: u32,
    pub html_count: u32,
    pub reason: Option<&'static str>,
    pub resolved_paths: Vec<String>,
}

struct Capture {
    id: String,
    document: String,
    expires: u64,
    phase: Phase,
    reason: Option<&'static str>,
    sequence: Option<i64>,
    native_id: Option<u64>,
    html_id: Option<String>,
    native_count: u32,
    html_count: u32,
    in_flight: bool,
    accepted: bool,
    paths: Vec<String>,
}

impl Capture {
    fn terminal(&self) -> bool {
        matches!(
            self.phase,
            Phase::Consumed | Phase::Ambiguous | Phase::Unmatched
        )
    }

    fn invalidate(&mut self, phase: Phase, reason: &'static str) {
        if !self.terminal() {
            self.phase = phase;
            self.reason = Some(reason);
            self.paths.clear();
        }
    }

    fn expire(&mut self, now: u64) {
        if now >= self.expires {
            self.invalidate(Phase::Unmatched, "expired");
        }
    }

    fn start_delivery(&mut self, now: u64) {
        self.expires = self.expires.min(now.saturating_add(DELIVERY_TTL_MS));
        self.phase = Phase::Pending;
    }

    fn reply(&mut self, generation: u64, consume: bool) -> Reply {
        let ready = !self.terminal()
            && self.native_count == 1
            && self.html_count == 1
            && !self.in_flight
            && self.accepted;
        let mut reply = Reply {
            phase: self.phase,
            generation,
            capture_id: self.id.clone(),
            native_drop_id: self.native_id,
            sequence: self.sequence,
            html_drop_id: self.html_id.clone(),
            native_count: self.native_count,
            html_count: self.html_count,
            reason: self.reason,
            resolved_paths: Vec::new(),
        };
        if ready && consume {
            reply.phase = Phase::Paired;
            reply.resolved_paths = std::mem::take(&mut self.paths);
            self.phase = Phase::Consumed;
        }
        reply
    }
}

pub struct CaptureState {
    generation: u64,
    closed: bool,
    used_ids: HashSet<String>,
    capture: Option<Capture>,
}

impl CaptureState {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            closed: false,
            used_ids: HashSet::new(),
            capture: None,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn active_id(&self) -> Option<&str> {
        self.capture.as_ref().map(|capture| capture.id.as_str())
    }

    pub fn arm(&mut self, id: String, document: String, now: u64) -> Result<Reply, &'static str> {
        if self.closed {
            return Err("window-closed");
        }
        if id.is_empty() || id.len() > 128 || document.is_empty() {
            return Err("invalid-capture-or-document-id");
        }
        if self.used_ids.contains(&id) {
            return Err("capture-id-already-used");
        }
        if self.used_ids.len() >= MAX_CAPTURE_IDS {
            return Err("capture-id-limit-reopen-window");
        }
        self.used_ids.insert(id.clone());
        // Re-preparation explicitly discards all prior paths and counters.
        self.capture = Some(Capture {
            id,
            document,
            expires: now.saturating_add(PREPARED_TTL_MS),
            phase: Phase::Armed,
            reason: None,
            sequence: None,
            native_id: None,
            html_id: None,
            native_count: 0,
            html_count: 0,
            in_flight: false,
            accepted: false,
            paths: Vec::new(),
        });
        Ok(self
            .capture
            .as_mut()
            .expect("capture just inserted")
            .reply(self.generation, false))
    }

    pub fn enter(&mut self, sequence: i64, internal: bool, now: u64) {
        if let Some(c) = self.capture.as_mut() {
            c.expire(now);
            if c.terminal() {
                return;
            }
            if internal {
                c.invalidate(Phase::Ambiguous, "internal-drag");
            } else if c.sequence.is_some_and(|old| old != sequence) {
                c.invalidate(Phase::Ambiguous, "multiple-drag-sequences");
            } else {
                c.sequence = Some(sequence);
            }
        }
    }

    pub fn native_begin(&mut self, id: u64, sequence: i64, internal: bool, now: u64) {
        self.enter(sequence, internal, now);
        if let Some(c) = self.capture.as_mut() {
            if c.terminal() {
                return;
            }
            c.native_count = c.native_count.saturating_add(1);
            if c.native_count != 1 {
                c.invalidate(Phase::Ambiguous, "duplicate-native-drop");
                return;
            }
            c.native_id = Some(id);
            c.in_flight = true;
            c.start_delivery(now);
        }
    }

    pub fn native_complete(
        &mut self,
        capture_id: &str,
        id: u64,
        paths: Vec<String>,
        accepted: bool,
        now: u64,
    ) {
        if let Some(c) = self.capture.as_mut() {
            c.expire(now);
            // A reentrant re-arm must not receive the old callback's paths.
            if c.terminal() || c.id != capture_id || c.native_id != Some(id) {
                return;
            }
            c.in_flight = false;
            if !accepted {
                c.invalidate(Phase::Unmatched, "native-destination-rejected");
            } else {
                c.accepted = true;
                c.paths = paths;
            }
        }
    }

    pub fn cancel_before_drop(&mut self, now: u64) {
        if let Some(c) = self.capture.as_mut() {
            c.expire(now);
            // AppKit may send lifecycle termination after a successful drop.
            if c.native_count == 0 {
                c.invalidate(Phase::Unmatched, "drag-cancelled-or-left-view");
            }
        }
    }

    pub fn invalidate(&mut self, reason: &'static str) {
        if let Some(c) = self.capture.as_mut() {
            c.invalidate(Phase::Unmatched, reason);
        }
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.invalidate("window-closed");
    }

    fn checked(
        &mut self,
        id: &str,
        document: Option<&str>,
        generation: u64,
        now: u64,
    ) -> Result<&mut Capture, Box<Reply>> {
        let reason = if self.closed {
            Some("window-closed")
        } else if generation != self.generation {
            Some("window-generation-changed")
        } else if self.capture.as_ref().is_none_or(|c| c.id != id) {
            Some("stale-or-unprepared-capture")
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(Box::new(Reply {
                phase: Phase::Unmatched,
                generation: self.generation,
                capture_id: id.to_owned(),
                native_drop_id: None,
                sequence: None,
                html_drop_id: None,
                native_count: 0,
                html_count: 0,
                reason: Some(reason),
                resolved_paths: Vec::new(),
            }));
        }
        let c = self.capture.as_mut().expect("capture checked above");
        c.expire(now);
        if document.is_some_and(|document| c.document != document) {
            c.invalidate(Phase::Unmatched, "document-changed");
        }
        Ok(c)
    }

    /// Count receipt before an asynchronous document check. Never resolves
    /// paths: two queued HTML deliveries must invalidate before either check
    /// can complete. The adapter subsequently calls `poll` with that document.
    pub fn note_html(&mut self, id: &str, html_id: String, generation: u64, now: u64) -> Reply {
        let own_generation = self.generation;
        let c = match self.checked(id, None, generation, now) {
            Ok(c) => c,
            Err(r) => return *r,
        };
        if !c.terminal() {
            c.html_count = c.html_count.saturating_add(1);
            if c.html_count != 1 {
                c.invalidate(Phase::Ambiguous, "duplicate-html-drop");
            } else if html_id.is_empty() || html_id.len() > 128 {
                c.invalidate(Phase::Unmatched, "invalid-html-drop-id");
            } else {
                c.html_id = Some(html_id);
                c.start_delivery(now);
            }
        }
        c.reply(own_generation, false)
    }

    pub fn finish_html(
        &mut self,
        id: &str,
        html_id: String,
        document: &str,
        generation: u64,
        now: u64,
    ) -> Reply {
        self.note_html(id, html_id, generation, now);
        self.poll(id, document, generation, now)
    }

    pub fn poll(&mut self, id: &str, document: &str, generation: u64, now: u64) -> Reply {
        let own_generation = self.generation;
        match self.checked(id, Some(document), generation, now) {
            Ok(c) => c.reply(own_generation, true),
            Err(r) => *r,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepared() -> CaptureState {
        let mut s = CaptureState::new(7);
        s.arm("a".into(), "doc".into(), 0).unwrap();
        s
    }
    fn native(s: &mut CaptureState) {
        s.native_begin(1, 42, false, 10);
        s.native_complete("a", 1, vec!["/原图.nef".into()], true, 11);
    }
    #[test]
    fn drop_capture_both_orders_and_once() {
        for html_first in [false, true] {
            let mut s = prepared();
            if html_first {
                assert_eq!(
                    s.finish_html("a", "h".into(), "doc", 7, 1).phase,
                    Phase::Pending
                );
                native(&mut s);
            } else {
                native(&mut s);
            }
            let r = if html_first {
                s.poll("a", "doc", 7, 12)
            } else {
                s.finish_html("a", "h".into(), "doc", 7, 12)
            };
            assert_eq!(r.phase, Phase::Paired);
            assert_eq!(r.resolved_paths, ["/原图.nef"]);
            assert_eq!(s.poll("a", "doc", 7, 13).phase, Phase::Consumed);
            assert!(
                s.finish_html("a", "h".into(), "doc", 7, 14)
                    .resolved_paths
                    .is_empty()
            );
        }
    }
    #[test]
    fn drop_capture_waits_for_original_return_and_rejects() {
        let mut s = prepared();
        s.native_begin(1, 42, false, 1);
        assert_eq!(
            s.finish_html("a", "h".into(), "doc", 7, 2).phase,
            Phase::Pending
        );
        assert!(s.poll("a", "doc", 7, 3).resolved_paths.is_empty());
        s.native_complete("a", 1, vec!["/x".into()], false, 4);
        assert_eq!(
            s.poll("a", "doc", 7, 5).reason,
            Some("native-destination-rejected")
        );
    }
    #[test]
    fn drop_capture_duplicate_native_and_html_before_completion() {
        let mut s = prepared();
        native(&mut s);
        s.native_begin(2, 42, false, 12);
        assert_eq!(
            s.finish_html("a", "h".into(), "doc", 7, 13).phase,
            Phase::Ambiguous
        );
        let mut s = prepared();
        s.finish_html("a", "h".into(), "doc", 7, 1);
        s.finish_html("a", "h2".into(), "doc", 7, 2);
        native(&mut s);
        assert_eq!(s.poll("a", "doc", 7, 13).phase, Phase::Ambiguous);
    }
    #[test]
    fn drop_capture_poll_never_counts_html() {
        let mut s = prepared();
        native(&mut s);
        for now in 12..20 {
            let r = s.poll("a", "doc", 7, now);
            assert_eq!(r.html_count, 0);
            assert!(r.resolved_paths.is_empty());
        }
        let mut s = prepared();
        s.note_html("a", "h".into(), 7, 1);
        for now in 2..10 {
            let r = s.poll("a", "doc", 7, now);
            assert_eq!(r.html_count, 1);
            assert_eq!(r.native_count, 0);
            assert_eq!(r.phase, Phase::Pending);
            assert!(r.resolved_paths.is_empty());
        }
        native(&mut s);
        assert_eq!(s.poll("a", "doc", 7, 12).phase, Phase::Paired);
        assert_eq!(s.poll("a", "doc", 7, 13).phase, Phase::Consumed);
    }

    #[test]
    fn drop_capture_queued_html_duplicates_cannot_resolve_before_document_check() {
        let mut s = prepared();
        native(&mut s);
        let first = s.note_html("a", "h1".into(), 7, 12);
        assert!(first.resolved_paths.is_empty());
        let second = s.note_html("a", "h2".into(), 7, 13);
        assert_eq!(second.phase, Phase::Ambiguous);
        let checked = s.poll("a", "doc", 7, 14);
        assert_eq!(checked.phase, Phase::Ambiguous);
        assert!(checked.resolved_paths.is_empty());
    }
    #[test]
    fn drop_capture_rearm_and_stale_completion() {
        let mut s = prepared();
        s.native_begin(1, 42, false, 1);
        s.arm("b".into(), "doc".into(), 2).unwrap();
        s.native_complete("a", 1, vec!["/old".into()], true, 3);
        assert_eq!(
            s.finish_html("a", "h".into(), "doc", 7, 4).phase,
            Phase::Unmatched
        );
        assert_eq!(s.poll("b", "doc", 7, 5).phase, Phase::Armed);
        assert!(s.arm("a".into(), "doc".into(), 6).is_err());
    }
    #[test]
    fn drop_capture_cancel_internal_sequence_expiry_document_generation_close() {
        for cause in 0..8 {
            let mut s = prepared();
            match cause {
                0 => s.cancel_before_drop(1),
                1 => s.enter(42, true, 1),
                2 => {
                    s.enter(42, false, 1);
                    s.enter(43, false, 2);
                }
                3 => {
                    s.poll("a", "doc", 7, PREPARED_TTL_MS);
                }
                4 => {
                    s.poll("a", "new-doc", 7, 1);
                }
                5 => {
                    let r = s.poll("a", "doc", 8, 1);
                    assert!(r.resolved_paths.is_empty());
                    s.close();
                }
                6 => s.close(),
                _ => {
                    s.finish_html("a", "h".into(), "doc", 7, 1);
                    s.poll("a", "doc", 7, DELIVERY_TTL_MS + 1);
                }
            }
            native(&mut s);
            let r = s.finish_html("a", "h".into(), "doc", 7, 20);
            assert!(matches!(r.phase, Phase::Unmatched | Phase::Ambiguous));
            assert!(r.resolved_paths.is_empty());
        }
    }
    #[test]
    fn drop_capture_end_after_drop_does_not_cancel_success() {
        let mut s = prepared();
        native(&mut s);
        s.cancel_before_drop(12);
        assert_eq!(
            s.finish_html("a", "h".into(), "doc", 7, 13).phase,
            Phase::Paired
        );
    }

    #[test]
    fn drop_capture_ready_result_rejects_document_change_and_wrong_generation() {
        let mut s = prepared();
        native(&mut s);
        s.note_html("a", "h".into(), 7, 12);
        let stale = s.poll("a", "doc", 8, 13);
        assert_eq!(stale.phase, Phase::Unmatched);
        assert!(stale.resolved_paths.is_empty());
        let changed = s.poll("a", "new-document-same-url", 7, 14);
        assert_eq!(changed.reason, Some("document-changed"));
        assert!(changed.resolved_paths.is_empty());
        assert!(s.poll("a", "doc", 7, 15).resolved_paths.is_empty());
    }

    #[test]
    fn drop_capture_explicit_internal_html_invalidation_and_empty_native_list() {
        let mut s = prepared();
        native(&mut s);
        let r = s.finish_html("a", String::new(), "doc", 7, 12);
        assert_eq!(r.phase, Phase::Unmatched);
        assert!(r.resolved_paths.is_empty());

        let mut s = prepared();
        s.native_begin(1, 42, false, 1);
        s.native_complete("a", 1, Vec::new(), true, 2);
        let r = s.finish_html("a", "web-image".into(), "doc", 7, 3);
        assert_eq!(r.phase, Phase::Paired);
        assert!(r.resolved_paths.is_empty()); // Pairing is not proof of a local file.
    }
}
