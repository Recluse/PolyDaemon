from __future__ import annotations

import time
from dataclasses import dataclass, field

from bot.storage import Storage


@dataclass(slots=True)
class PendingCustomAsk:
    """Transient marker that the next text message from this user should be
    delivered as the free-text answer to an in-flight AskUserQuestion instead
    of being forwarded as a normal chat message."""
    ask_id: str
    instance_key: str
    expires_at: float  # epoch seconds — past this we silently drop the marker


@dataclass(slots=True)
class UserSession:
    user_id: int
    active_instance: str
    last_activity: float  # epoch seconds
    # Not persisted: rebuilt on plugin/bot restart by simply timing out the
    # plugin-side pending entry. Keeping it in memory avoids growing the DB
    # schema for what is at most a 10-minute window.
    pending_custom_ask: PendingCustomAsk | None = field(default=None)


class SessionStore:
    """In-memory cache backed by SQLite.

    Reads go to the cache; writes go through to SQLite so an active-window
    selection survives bot restart without the user having to re-pick.
    """

    def __init__(self, storage: Storage, default_instance: str = "") -> None:
        self._storage = storage
        self._default_instance = default_instance
        self._sessions: dict[int, UserSession] = {
            uid: UserSession(uid, inst, ts)
            for uid, (inst, ts) in storage.load_sessions().items()
        }

    def get(self, user_id: int) -> UserSession:
        session = self._sessions.get(user_id)
        if session is None:
            session = UserSession(user_id=user_id, active_instance=self._default_instance, last_activity=time.time())
            self._sessions[user_id] = session
            # Only persist non-empty defaults — an empty active_instance is meaningless and
            # would just clutter the table with placeholder rows.
            if session.active_instance:
                self._storage.upsert_session(user_id, session.active_instance)
        return session

    def set_active_instance(self, user_id: int, instance_name: str) -> UserSession:
        session = self.get(user_id)
        session.active_instance = instance_name
        session.last_activity = time.time()
        if instance_name:
            self._storage.upsert_session(user_id, instance_name)
        return session

    def to_active_map(self) -> dict[int, str]:
        return {
            uid: s.active_instance
            for uid, s in self._sessions.items()
            if s.active_instance
        }

    def set_pending_custom_ask(self, user_id: int, ask_id: str, instance_key: str, ttl_seconds: float = 600.0) -> None:
        """Mark this user as in the middle of answering an AskUserQuestion with
        free text. Cleared on consume or when the TTL elapses (whichever first)."""
        session = self.get(user_id)
        session.pending_custom_ask = PendingCustomAsk(
            ask_id=ask_id,
            instance_key=instance_key,
            expires_at=time.time() + ttl_seconds,
        )

    def peek_pending_custom_ask(self, user_id: int) -> PendingCustomAsk | None:
        """The pending marker WITHOUT consuming it, or None if absent/expired.

        Needed so a caller can check which window the marker belongs to before
        deciding to take it: a message typed in one window's topic must not
        consume an answer marker that belongs to a different window.
        """
        session = self._sessions.get(user_id)
        if session is None or session.pending_custom_ask is None:
            return None
        marker = session.pending_custom_ask
        if marker.expires_at < time.time():
            session.pending_custom_ask = None   # expired: clear it while we are here
            return None
        return marker

    def consume_pending_custom_ask(self, user_id: int) -> PendingCustomAsk | None:
        """Pop the pending marker if it exists and hasn't expired."""
        session = self._sessions.get(user_id)
        if session is None or session.pending_custom_ask is None:
            return None
        marker = session.pending_custom_ask
        session.pending_custom_ask = None
        if marker.expires_at < time.time():
            return None
        return marker


if __name__ == "__main__":  # self-check: python3 tg-bot/bot/session.py
    class _FakeStorage:
        def load_sessions(self): return {}
        def upsert_session(self, *a, **k): pass

    st = SessionStore(_FakeStorage())
    UID = 7

    # peek must not consume: the marker has to survive a message typed in some
    # OTHER window's topic, which is the whole reason peek exists.
    st.set_pending_custom_ask(UID, "a1", "winA")
    assert st.peek_pending_custom_ask(UID).instance_key == "winA"
    assert st.peek_pending_custom_ask(UID).instance_key == "winA"
    assert st.consume_pending_custom_ask(UID).ask_id == "a1"
    assert st.consume_pending_custom_ask(UID) is None, "consume must be once-only"

    # An expired marker reads as absent from both, and peek clears it so it
    # cannot sit around pretending to be armed.
    st.set_pending_custom_ask(UID, "a2", "winA", ttl_seconds=-1)
    assert st.peek_pending_custom_ask(UID) is None
    assert st.consume_pending_custom_ask(UID) is None

    # The routing rule text_message applies, spelled out here so it is checkable
    # without a running bot: in a topic, accept only that topic's own window.
    def accepts(marker_window, topic_key):
        st.set_pending_custom_ask(UID, "x", marker_window)
        if topic_key is not None:
            p = st.peek_pending_custom_ask(UID)
            if p is None or p.instance_key != topic_key:
                return False
        return st.consume_pending_custom_ask(UID) is not None

    assert accepts("winA", None), "DM: any pending marker is the answer"
    assert accepts("winA", "winA"), "topic of the asking window: accept"
    assert not accepts("winA", "winB"), "another window's topic: must NOT accept"
    # ...and the marker is still armed for winA after winB's topic declined it.
    assert st.peek_pending_custom_ask(UID).instance_key == "winA"
    print("session self-check OK")

