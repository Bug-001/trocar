---
name: trocar-ux
description: The standard of detail for trocar's board. Use when designing, building, reviewing or testing any board screen, or when someone says a screen feels wrong. Defines what a detail is, the twelve checks a screen must pass, and what to open, scroll, drag and wait for on each kind of screen.
---

# trocar-ux: the board's standard of detail

This is the one home of the standard. `trocar-debug`, `trocar-fix`, `trocar-pr` and every human reviewer use this text. The look itself (type, colour, tokens) is in spec unit 1.5; this file is about whether a screen works for the person using it.

## What a detail is

A detail is any place where what a person sees, can do or gets back differs from what the screen led them to expect, in any state real data can put that screen in.

So "no detail missed" does not mean looking harder. It means walking a product of three lists until it is finished:

- **Things:** every kind of thing on the screen (each kind of row, step, block and control).
- **States:** longest, shortest, empty, failed, still growing, non-Latin text, huge, exactly on a boundary.
- **Actions:** open it, scroll to the end, drag to both limits, leave and come back, wait for a data update.

A screen that looks right on one example has been looked at, not checked.

## The twelve checks

A screen passes only if all twelve hold, and they are checked by using it. Each check names what failing looks like.

1. **People's content first.** The default view is what a person came to read: the assembled reply (text, thinking, tool name and arguments), rendered Markdown, a tool's description as prose. Wire format is one click away and never the default.
   *Failing:* opening a reply shows SSE events and JSON deltas.
2. **Readable means readable.** Not the raw body in another font. Markdown renders as Markdown at reading width, a label column never eats the content's width, and monospace is only for literal bytes and identifiers.
   *Failing:* a tool description squeezed beside a wide column of field names.
3. **Every control does what its label and shape promise.** A bar labelled as the whole session moves over the whole session, a thing that looks draggable drags, and a range label matches what is drawn.
   *Failing:* a scrubber that covers the loaded page while its label says the session.
4. **You can always leave.** Title, back and close stay in place however far the content scrolls. Esc works, and focus comes back to where it was.
   *Failing:* scrolling a long body carries the close button out of view.
5. **What the user did stays.** Expanded rows, chosen mode, scroll, selection and focus survive every data update, keyed by stable ids.
   *Failing:* a poll collapses the row being read.
6. **Sizes are the user's.** Panels drag to resize and remember it.
   *Failing:* a panel snaps back after a reload.
7. **Names say what a thing is, in the user's terms.** No catch-alls for what is really a whole agent session, and no word the user must decode.
   *Failing:* a sub-agent's whole session filed under "other background call"; a title like "near step 8077 (inferred)".
8. **No internal states on show.** No "not read yet", and no wait for something that could have been known earlier. Slow work never blocks small work.
   *Failing:* a list row says "pending" until a large read elsewhere finishes.
9. **Space goes to content.** No short content stretched fat, none squeezed in a corner, no empty half-screens.
   *Failing:* a three-line reply in a full-height pane beside a cramped list.
10. **One fact, one place.** A panel that repeats another is deleted.
    *Failing:* the same totals in the header and in a card under it.
11. **Things are grouped the way the user thinks of them.** For example, everything in a timeline follows the same part.
    *Failing:* a sub-agent's calls split between two rows of the timeline.
12. **Verified in use.** The biggest real session, while it grows, at the user's window size, in both themes: open every kind of item, scroll every panel to its end, drag every handle. Screenshots of generated data show a defect; they do not prove its absence.

## What to walk on each kind of screen

| Kind of screen | Must open | Must scroll | Must drag | Must wait for, or come back to |
|---|---|---|---|---|
| Lists (session library, traffic table, host page) | First row, last row, longest title, a row with no title, a failed row, one row of each agent; filter down to nothing | Past every page, to the real end | Column and pane handles, if any | Go in and come back: position, filters and selection are all still there |
| Replay desk | Every kind of step: user turn, reply, thinking, tool call, tool result, compaction, failed call, log-only call, image. Every kind of lane: main thread, sub-agent, each background kind. The first step, the last step, a step across a chapter line | Every panel to its end; title, back and close stay put | Every splitter to its minimum and maximum; the whole-session range from end to end | Follow a growing session for two updates: expansion, mode, scroll, selection and focus are unchanged |
| Details and drawers | Every kind of content: Markdown, JSON, a huge block, an empty block, binary, non-Latin text. The default view passes check 1 | Content to its end | Panel width; it is remembered when reopened | Esc, back, focus returns to the opener |
| Timelines and traces | Points on every lane, a dense cluster, a lane with no points | Across the whole range | Range handles; the range text equals what is drawn | When new points arrive, the selected one does not jump |
| Capture page | Each agent state: on, off, needs setup, failing; cancel on every confirmation | Expanded rows to the end | None | The state updates by itself after a switch |
| Settings | Every class, a model with no price; switch the theme on every screen | To the end | None | Change something, leave, come back |
| Empty, failed, slow (every screen) | No data, daemon not running, a 403, a 500 with a long reason, a read that takes 3 s | None | None | Small actions are not blocked by slow ones; no internal state word appears |

**Every walk also covers:** the user's own window size and one narrow window, both themes, and the biggest real session available.

## How to walk

1. Read the screen's source in `web/` first, so you know what each control promises.
2. List the things, states and actions for this screen from the table. Mark which states the data you have can reach.
3. Use the screen. `scripts/board-walk.mjs` in the repository opens every expandable, scrolls every scroller and drags every separator by accessibility role, and records what had no effect. It does not judge content, layout or names: you do that from the screenshots and the checks above.
4. For anything the data at hand cannot reach, say so. Do not count it as passed.

## Evidence

For each check, give one of: **pass**, **fail**, or **not reachable here** with the reason, and say which state you looked at it in.

- A failure names the screen, the thing, the state, the action, and what happened instead.
- Screenshots of real sessions are for your own eyes. They stay on the machine, outside the repository, and are deleted when the work ends.
- A pull request lists check numbers and results only. It never carries a screenshot or a description of what a real session contained.
