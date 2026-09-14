# P2 Task 10 report: chat sidebar

## Implemented

- Added `useChat`, `Sidebar`, `ConversationView`, and `HistoryList`.
- Connected a selection store to `ReaderView` and passed visible range, TOC, and quotes into the sidebar.
- Added all Task 10 test ids for sidebar, composer actions, messages, quotes, history, and full-book conversations.
- Added collapsible sidebar styling and persisted `sidebarWidth`.
- Tightened Markdown sanitization by removing form controls and `style` attributes.
- Added renderer CSP `img-src 'self' data:` and removed remote image `src` attributes during sanitization.

## Verification

- `npm run build`: passed (`tsc --noEmit`, main/preload/renderer bundles).
- `npm test`: passed, 26 files / 370 tests.
- `npm run test:e2e`: passed, 20 tests.
- `npm run dev`: started successfully; kept running for about 20 seconds, then stopped. Output showed successful main/preload builds and renderer server at `http://localhost:5173/`; no startup or build errors.

## Mutation checks

1. Temporarily changed `FORBID_TAGS` to `[]`; `tests/unit/markdown.test.ts` failed on the form payload. Restored the controls deny-list; targeted test passed.
2. Temporarily changed the renderer CSP to `img-src *;`; the CSP assertion failed. Restored the local/data/blob allowlist; targeted test passed.

The existing Task 8 no-consumer regression remains green by retaining its explicit E2E hook path; production creates the selection store normally.

## Independent review fix round (a8ce491)

- Bound every streaming request and assistant commit to the conversation id captured before `startChat`; conversation/page changes abort active and pending requests, and a late `startChat` result is aborted after disposal.
- Added a synchronous send lock covering create, append, and start awaits; delayed conversation-created notification until the user message is stored, and retained local messages when an empty list read races the new message.
- Caught create, user/assistant append, start, and abort IPC failures with Chinese chat errors while releasing the lock consistently.
- Changed the renderer CSP to allow local, data, and blob images only; Markdown now rejects protocol-relative remote images by origin and removes `srcset`.
- Chapter history identity now uses the CFI package path, excludes the active conversation from history, and the full-book count is `conversations.length`. Page-folding remains deferred to Task 11 because Task 10's model has no reliable page-to-history mapping; no synthetic page numbers are shown.
- Added `cfiChapterKey`, `mergeLoadedMessages`, and five real React hook/lifecycle tests covering request binding, double-send locking, late start abort, load overwrite, and IPC errors.

Verification: `npm run build` passed; `npm test` passed (27 files / 377 tests); `npx playwright test --workers=1` passed (20 tests, 35.7s).
