# refine.page

A web extension for capturing and annotating web page snapshots for labeling and review. Similar to Zotero's snapshot functionality, but focused on creating labeled datasets from web pages.

## Features

- **High-Fidelity Snapshots**: Captures complete web pages as self-contained HTML files using SingleFile-style capture
- **Inert Snapshots**: All interactive elements (links, forms, scripts) are disabled to preserve the exact state
- **Text Annotations**: Highlight and label text content with different annotation types:
  - **Relevant**: Mark content that is relevant to a query
  - **Answer**: Mark content that contains the answer
  - **No Content**: Mark when no relevant content exists
- **Q&A Labeling**: Create question-answer pairs for each snapshot with:
  - Query text
  - Expected answer
  - Annotation links to highlighted text
- **Evaluation Metrics**: Rate each Q&A pair with:
  - Answer correctness (correct/incorrect/partial)
  - Answer in page (yes/no/unclear)
  - Page content quality (good/broken)
- **Review Workflow**: Approve or decline snapshots with optional review notes
- **Export/Import**: Backup and restore your labeled data as JSON files
- **Local Storage**: All data stored locally using Chrome storage API (portable and exportable)

## Installation

### Development Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the extension:
   ```bash
   npm run build
   ```

3. For development with auto-rebuild:
   ```bash
   npm run dev
   ```

### Loading the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `dist` folder from this project

## Usage

### Capturing Pages

1. Navigate to any web page you want to capture
2. Click the refine.page extension icon
3. Click "Capture Page"
4. The page will be saved as an inert snapshot

### Annotating Snapshots

1. Click "View Snapshots" or click on a recent snapshot
2. In the viewer:
   - Select an annotation tool (Relevant, Answer, or No Content)
   - Select text in the page preview to create annotations
   - The selected text will be highlighted with the annotation type's color

### Creating Questions

1. Click "+ Add Question" in the right panel
2. Enter the query and expected answer
3. Create annotations that are linked to this question
4. Fill out the evaluation metrics

### Reviewing

1. Use the filter tabs to see pending or completed snapshots
2. Review annotations and evaluations
3. Click "Approve" or "Decline" to update the status
4. Add review notes if needed

### Exporting Data

1. Click "Export" in the popup to download all snapshots as JSON
2. Click "Import" to restore from a backup file

## Using a hosted (3p) annotator iframe

By default the viewer loads `iframe.html` from the extension bundle via `chrome.runtime.getURL(...)`.
If you want to run the annotator iframe from a web server (so the same “eval service” can be hosted and reused),
you can point the viewer at a third-party base URL that serves:

- `iframe.html`
- `iframe-annotator.js`

You can configure this in either of these ways:

- **Query param**: open the viewer with `annotatorBase=https://your-host.example/path/`
- **LocalStorage (persists)**: set `refine-annotator-base-url` to your base URL

Example localStorage (run in the viewer tab DevTools console):

```js
localStorage.setItem('refine-annotator-base-url', 'https://your-host.example/refine/');
```

## Project Structure

```
refine-page/
├── src/
│   ├── types/           # TypeScript type definitions
│   ├── background/      # Service worker for message handling
│   ├── content/         # Content script for page capture
│   ├── popup/           # Extension popup UI
│   ├── viewer/          # Full-page annotation viewer
│   └── snapshot/        # Snapshot preview page
├── icons/               # Extension icons
├── scripts/             # Build scripts
└── dist/                # Built extension (generated)
```

## Dependencies

- **single-file-core**: High-fidelity web page capture
- **@annotorious/annotorious**: Image/region annotation (for future use)
- **@recogito/text-annotator**: Text annotation (for future use)

## Data Format

Snapshots are stored with the following structure:

```typescript
interface Snapshot {
  id: string;
  url: string;
  title: string;
  html: string;           // Complete self-contained HTML
  viewport: { width: number; height: number };
  annotations: {
    text: TextAnnotation[];
    region: RegionAnnotation[];
  };
  questions: Question[];
  status: 'pending' | 'approved' | 'declined' | 'needs_revision';
  reviewNotes?: string;
  capturedAt: string;
  updatedAt: string;
  tags: string[];
}
```

## License

MIT
