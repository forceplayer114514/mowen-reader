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

## Second independent review fix round (3b52cb6..HEAD)

- Bound the busy lock, pending start, request, assistant commit, abort-error handling, and streaming cleanup to one owner token. A canceled request's late `startChat` resolve/reject or `finally` can only abort itself and cannot release or clear a newer request.
- Delete a just-created conversation when cancellation or user-message append failure leaves it without a message; cleanup rejection is intentionally swallowed.
- Changed `ChatState.setMessages` to accept React `SetStateAction`. Sidebar now filters old-conversation messages on every id change and uses functional updaters for late `listMessages` results, preserving newer local messages while stale loads are canceled.
- Added real React timing tests for deferred A/B starts (resolve and reject), delayed assistant append, empty-conversation cleanup, and Sidebar's late empty load.

Mutation verification: removing the owner guard made the resolve/finally race tests fail (2 failures); restoring it returned the targeted suite to green (11/11).

Verification: `npm run build` passed; `npm test` passed (27 files / 383 tests); `npm run test:e2e` passed (20 tests).

## Third independent review fix round (based on HEAD c5dd383)

- Made `stop()` cancel the active owner across deferred conversation creation, user-message append, and `startChat`; it increments the generation, clears streaming/error UI, aborts late request ids, and removes a newly created empty conversation after cancellation or append failure without touching a newer owner.
- Cleared `lastAttemptRef` and `error` whenever the conversation id or visible page changes, preventing retry from reusing a failure from the previous location.
- Changed `mergeLoadedMessages` to preserve loaded order, deduplicate by message id, append same-conversation local messages missing from a non-empty snapshot, and exclude other conversations.
- Added four hook/lifecycle tests and one merge test. The deferred append test verifies empty-conversation cleanup on failure; the deferred start test verifies a later owner still starts.

Mutation verification: replacing `stop()` with a no-op failed 3 tests; removing conversation/page reset guards failed the corresponding retry tests; replacing message merge with the old snapshot return failed 3 tests. Restoring each guard returned the targeted tests to green.

Verification: `npm run build` passed; `npm test` passed (27 files / 389 tests); `npm run test:e2e` passed (20 tests, 35.3s).

## Fourth independent review fix round (based on HEAD 6275389)

- User stop now keeps the request eligible to commit its accumulated assistant text after `chat:done`, while late chunks and abort errors remain hidden. Switching conversation/page still marks the request non-current, so old output cannot enter the new UI. A subsequent send in the same conversation receives the stopped partial answer in its context.
- Sidebar conversation loads use a monotonic request sequence and effect cleanup invalidation. Older deferred responses are ignored, so an initial snapshot cannot overwrite a post-create/post-delete refresh or clear the active conversation and abort its new request. Load failures retain the last usable list.
- Empty-conversation cleanup and `newConversation` deletion now surface Chinese errors with an explicit manual-delete fallback; every rejection is handled. Cleanup errors are only surfaced for the current owner or an explicit user stop.
- Added real React timing tests for stopped partial persistence/context, stale Sidebar list responses, hook cleanup rejection visibility, and `newConversation` deletion rejection visibility.

Mutation verification:

1. Temporarily made stop mark the request non-current; the partial persistence/context test failed (1 failure). Restored stop ownership; targeted suite passed (21/21).
2. Temporarily removed the Sidebar request-sequence guard; the stale-response test failed because `abortChat('request-1')` was called. Restored the guard; targeted suite passed (21/21).

Verification: `npm run build` passed; `npm test` passed (27 files / 393 tests); `npm run test:e2e` passed (20 tests, 35.3s).
