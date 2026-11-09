// Seen and unseen (DESIGN.md "Seen and unseen"): a ticket's detail with focus marks the ticket seen.
// It reacts to focus changes and to new agent or system Activity, never to the unseen flag itself,
// so "Mark ticket unseen" from a focused detail stays unseen until focus leaves and comes back.

import { useEffect, useRef, useState } from "react";
import type { Ticket } from "@harness/shared";
import { useStore } from "./store";

/** Whether this window has focus: a blurred window's panes aren't being looked at. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => (typeof document.hasFocus === "function" ? document.hasFocus() : true));
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    addEventListener("focus", on);
    addEventListener("blur", off);
    return () => (removeEventListener("focus", on), removeEventListener("blur", off));
  }, []);
  return focused;
}

/**
 * Marks `ticket` seen when its detail gains focus (`paneFocused` and the window's focus), and again
 * when agent or system Activity arrives for it while it has focus.
 */
export function useMarkSeen(ticket: Ticket | undefined, paneFocused: boolean) {
  const { client, onEvent } = useStore();
  const focused = useWindowFocused() && paneFocused;
  const current = useRef(ticket);
  current.current = ticket;
  const key = ticket?.key;

  // Focus gained (or the ticket loaded while focused): only an unseen ticket needs the write.
  useEffect(() => {
    const t = current.current;
    if (focused && t?.unseen) void client.setSeen(t.key, true).catch(() => {});
  }, [focused, key, client]);

  // New activity while focused: the service has already marked it unseen, so mark it seen again.
  useEffect(() => {
    if (!focused) return;
    return onEvent((e) => {
      const t = current.current;
      if (e.kind === "activity.added" && t && e.entry.ticketId === t.id && e.entry.author !== "human") void client.setSeen(t.key, true).catch(() => {});
    });
  }, [focused, onEvent, client]);
}
