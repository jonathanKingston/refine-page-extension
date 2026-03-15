# refine.page - 50 Codebase Improvement Ideas

## Testing (1-8)

1. **Add Chrome API mock infrastructure** - Create reusable mocks for `chrome.storage`, `chrome.runtime`, `chrome.tabs`, and `chrome.pageCapture` to enable unit testing of background and popup scripts.

2. **Add viewer.ts unit tests** - The viewer is ~2300 lines with zero tests. Add tests for snapshot list rendering, panel switching, keyboard shortcuts, and review workflow.

3. **Add annotator.ts unit tests** - The iframe annotator is ~2100 lines untested. Test annotation creation, message handling, tool switching, and W3C format compliance.

4. **Add popup.ts unit tests** - Test capture flow, export/import logic, snapshot list rendering, and UI state management.

5. **Add E2E tests with Playwright** - Test the full extension workflow: install extension, capture a page, annotate text, create Q&A, export ZIP, and re-import.

6. **Add storage operation tests** - Test snapshot CRUD operations, index management, and edge cases like storage quota exceeded.

7. **Add message passing tests** - Verify all 8+ message types between background, content, popup, viewer, and iframe with typed request/response contracts.

8. **Add snapshot export/import round-trip tests** - Verify ZIP export produces valid archives and re-import restores identical data including annotations and questions.

## Type Safety & Validation (9-14)

9. **Add runtime validation with Zod** - Add schema validation at system boundaries (storage reads, message passing, import parsing) to catch data corruption early.

10. **Type-safe Chrome message passing** - Replace `payload: unknown` with discriminated union types for all message types, ensuring compile-time safety for request/response pairs.

11. **Strict null checks for DOM queries** - Audit all `document.querySelector` calls and add proper null guards or assertion helpers instead of silent `!` operators.

12. **Add branded types for IDs** - Use TypeScript branded types for `SnapshotId`, `AnnotationId`, `QuestionId` to prevent accidental ID mixups at compile time.

13. **Validate imported JSON schema** - When importing snapshots from JSON/ZIP, validate the schema strictly and provide detailed error messages for malformed data.

14. **Add return type annotations to all exported functions** - Explicit return types serve as documentation and catch unintentional type changes.

## Architecture & State Management (15-22)

15. **Extract state management from viewer.ts** - Move module-level mutable state into a centralized store with typed actions, making state changes trackable and testable.

16. **Extract state management from annotator.ts** - Same as above for the iframe annotator's scattered global state variables.

17. **Create a typed event bus for iframe communication** - Replace ad-hoc `postMessage` calls with a typed publish/subscribe system that validates message shapes.

18. **Split viewer.ts into modules** - Break the 2300-line viewer into focused modules: SnapshotList, AnnotationPanel, QuestionPanel, ReviewPanel, KeyboardShortcuts.

19. **Split annotator.ts into modules** - Break the 2100-line annotator into: TextAnnotationManager, RegionAnnotationManager, WebmarkerManager, MessageHandler.

20. **Add undo/redo for annotations** - Implement a command pattern to allow users to undo/redo annotation and question changes.

21. **Use IndexedDB for large snapshot HTML** - Move large HTML blobs from `chrome.storage.local` to IndexedDB to avoid the 10MB per-item limit and improve performance.

22. **Add a proper dependency injection pattern** - Instead of direct Chrome API calls throughout, inject dependencies to enable easier testing and potential Firefox porting.

## Performance (23-28)

23. **Lazy-load snapshot HTML** - Only load the HTML content when a snapshot is selected, not when listing all snapshots in the sidebar.

24. **Add pagination/virtual scrolling for snapshot list** - When users have hundreds of snapshots, the sidebar should virtualize the list instead of rendering all DOM nodes.

25. **Enable esbuild minification for production builds** - Add `minify: true` to the production build config to reduce bundle size.

26. **Add code splitting** - Split the viewer and annotator bundles so shared dependencies (like annotation libraries) are loaded once.

27. **Debounce annotation saves more aggressively** - Batch rapid annotation changes into single storage writes to reduce I/O overhead.

28. **Add a storage usage indicator** - Show users how much local storage space snapshots are consuming and warn when approaching limits.

## UI/UX (29-38)

29. **Add ARIA labels and roles throughout** - Audit all interactive elements for screen reader accessibility and add proper ARIA attributes.

30. **Add keyboard navigation for all panels** - Ensure all panels, lists, and controls are fully navigable with Tab, Arrow keys, Enter, and Escape.

31. **Add a unified theming system** - Replace scattered `localStorage` theme checks with CSS custom properties and a proper theme provider.

32. **Add search/filter for snapshots** - Allow filtering snapshots by URL, title, date range, and full-text search across questions and annotations.

33. **Add bulk operations** - Multi-select snapshots for bulk delete, bulk export, bulk status changes (approve/decline).

34. **Add drag-and-drop reordering for questions** - Let users reorder Q&A pairs within a snapshot by dragging.

35. **Add a confirmation dialog for destructive actions** - Confirm before deleting snapshots, clearing all annotations, or removing questions.

36. **Improve error messages** - Replace generic "Error" messages with actionable descriptions that tell users what went wrong and how to fix it.

37. **Add loading states and skeleton UI** - Show skeleton placeholders while snapshots load instead of blank panels.

38. **Add annotation color customization** - Let users pick custom colors for annotation categories beyond the fixed green/blue.

## Security (39-42)

39. **Add Content Security Policy to all extension pages** - Ensure popup, viewer, and snapshot pages have strict CSP headers preventing XSS.

40. **Sanitize imported HTML snapshots** - When importing snapshots, run HTML through DOMPurify to strip any injected scripts or event handlers.

41. **Add subresource integrity for vendor libraries** - Pin vendor library hashes to detect tampering.

42. **Audit blob URL lifecycle** - Ensure all `URL.createObjectURL` calls have corresponding `URL.revokeObjectURL` to prevent memory leaks and reduce attack surface.

## Developer Experience (43-47)

43. **Add JSDoc comments to all public functions** - Document parameters, return values, and side effects for all exported functions.

44. **Add a CONTRIBUTING.md guide** - Document the development setup, architecture overview, coding conventions, and PR process.

45. **Add hot reload for development** - Use esbuild's watch mode with a Chrome extension reload plugin to auto-refresh during development.

46. **Add pre-commit hooks with Husky** - Run lint, format check, and typecheck before every commit to catch issues early.

47. **Add GitHub issue templates** - Create templates for bug reports, feature requests, and improvement proposals.

## Features (48-50)

48. **Add CSV/Parquet export for ML pipelines** - Export Q&A pairs and annotations in tabular formats that integrate directly with ML training workflows.

49. **Add annotation statistics dashboard** - Show metrics like annotations per snapshot, question coverage, inter-annotator agreement, and labeling velocity.

50. **Add Firefox extension support** - Abstract Chrome-specific APIs behind a browser abstraction layer to support Firefox's WebExtensions API.
