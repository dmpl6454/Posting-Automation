# Media Editor Design Spec

**Date:** 2026-03-16
**Status:** Approved

## Overview

Integrate a Canva-style inline media editor into the post creation flow using Fabric.js. Users can create, edit, and template static images with manual tools and AI-powered edits before attaching to posts.

## Decisions

| Decision | Choice |
|----------|--------|
| Editor library | Fabric.js (canvas-based, MIT, full control) |
| Integration style | Inline within ComposeTab (replaces content area when editing) |
| Template scope | Global (admin) + per-organization (users) |
| Template types | News card, quote card, promo banner, announcement, before/after, story, carousel slide + custom |
| AI editing | Gemini API for prompt-based edits, background removal, style transfer |
| Editor UI style | Canva-style: left sidebar panels, contextual top toolbar, right canvas workspace |
| Video editing | Out of scope for v1 |

## Architecture

### Component Tree

```
ComposeTab
├── (normal compose view — content editor, channels, schedule)
└── MediaEditor (shown when editing, replaces left column)
    ├── EditorSidebar (left — vertical icon strip + expandable panels)
    │   ├── TemplatePanel
    │   ├── ElementsPanel (shapes, lines, frames, stickers, icons)
    │   ├── TextPanel (preset styles, font combinations)
    │   ├── UploadsPanel (file upload, media library, AI images)
    │   ├── DrawPanel (freehand, pen, highlighter, eraser)
    │   └── AIPanel (AI edit prompt, bg removal, style transfer, magic eraser)
    ├── EditorToolbar (top — contextual based on selection)
    │   ├── TextToolbar (font, size, color, bold/italic, alignment, spacing, effects)
    │   ├── ShapeToolbar (fill, border, opacity, corner radius)
    │   ├── ImageToolbar (filters, crop, flip, opacity, blend mode)
    │   └── CanvasToolbar (canvas size, background, zoom, grid)
    ├── FabricCanvas (center — main editing area)
    ├── LayerPanel (right — toggle, shows all objects, reorder, visibility, lock)
    └── BottomBar (undo/redo, zoom slider)
```

### Data Flow

```
Entry Points:
  - "Edit" on attached image in postMedia[]
  - "Create Design" button (blank canvas or template picker)
  - "Edit This Image" from AI generation result
  - Image from media library

Editor Flow:
  Image (base64/URL) → Load onto Fabric.js canvas
                      → Manual edits (tools, text, shapes, filters)
                      ⇄ AI edits (export canvas → Gemini API → load result back)
                      → Export canvas as PNG/JPG

Exit Points:
  - "Apply to Post" → export to base64/blob → add to postMedia[] → close editor
  - "Save to Library" → upload exported image to S3 via media API
  - "Save as Template" → serialize Fabric.js JSON → save to DesignTemplate table
  - "Cancel" → discard changes → return to compose view
```

## Editor Tools

### Left Sidebar Panels

| Icon | Panel | Contents |
|------|-------|----------|
| Templates | Template browser | Global + org templates, search by name/category |
| Elements | Shapes & graphics | Rectangle, circle, line, arrow, star, polygon, frames, stickers, icon library |
| Text | Text styles | "Add heading/subheading/body", font combinations, text effects (shadow, outline, curved) |
| Uploads | Media | Upload files, browse media library, recent AI-generated images |
| Draw | Drawing tools | Freehand brush, pen, highlighter, eraser with size/color controls |
| AI | AI tools | Prompt-based edit, background removal, style transfer, magic eraser |

### Contextual Top Toolbar

**Text selected:**
- Font family, size, color, bold/italic/underline, alignment, letter/line spacing, effects (shadow, outline, curved text)

**Shape selected:**
- Fill color (solid/gradient), border color, border width, opacity, corner radius, blend mode

**Image selected:**
- Preset filters (10+: vintage, noir, warm, cool, fade, vivid, dramatic, b&w, sepia, film grain), brightness, contrast, saturation, blur, sharpen, crop, flip, opacity, blend mode

**Nothing selected (canvas):**
- Canvas size presets (1:1 Instagram, 16:9 landscape, 9:16 story, 4:5 portrait, custom), background color/gradient, zoom level, grid toggle

### Advanced Features

- **Layers panel** — all objects listed, drag to reorder, eye icon (visibility), lock icon (prevent edits), delete
- **Blend modes** — normal, multiply, screen, overlay, darken, lighten (per object)
- **Masking** — clip images to shapes
- **Gradient fills** — linear and radial gradients for shapes and backgrounds
- **Custom fonts** — upload .ttf/.otf/.woff2, stored in S3, loaded via FontFace API
- **Undo/Redo** — Ctrl+Z / Ctrl+Y with full history stack

### Canvas Controls

- Zoom: scroll wheel + slider (25%-400%)
- Pan: spacebar + drag
- Canvas size presets with custom option
- Snap to grid (toggle)
- Ruler guides (toggle)

## AI Editing Integration

### AI Edit (Prompt-Based)

1. User clicks AI tool in sidebar, enters instruction (e.g., "remove background", "add sunset sky")
2. Canvas exports current state as base64 PNG
3. Sent to existing `image.edit` tRPC mutation (Gemini image edit API)
4. Result loads back onto canvas as a new image layer
5. User can undo (Ctrl+Z) if they don't like the result
6. Can iterate: make manual tweaks, then AI edit again

### AI Background Removal

1. One-click button in AI panel
2. Sends selected image layer to Gemini with prompt: "Remove the background, make it transparent"
3. Result replaces the image layer with transparent background

### AI Style Transfer

1. User selects a style from presets (watercolor, oil painting, pencil sketch, comic, pop art, etc.)
2. Sends canvas to Gemini with style instruction
3. Result loads as new layer

### AI Text Suggestions

1. User selects a text layer, clicks "AI Rewrite" in AI panel
2. Sends current text + context (post content, template type) to text generation API
3. Returns 3 alternative options, user picks one or keeps original

## Template System

### Database Model

```prisma
model DesignTemplate {
  id             String       @id @default(cuid())
  name           String
  category       String       // "news_card", "quote", "promo", "announcement", "story", "carousel", "custom"
  thumbnail      String       // S3 URL — auto-generated PNG preview
  canvasJson     Json         // Fabric.js serialized canvas state
  width          Int
  height         Int
  isGlobal       Boolean      @default(false)
  organizationId String?
  organization   Organization? @relation(fields: [organizationId], references: [id])
  createdById    String
  createdBy      User         @relation(fields: [createdById], references: [id])
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([organizationId])
  @@index([isGlobal])
  @@index([category])
}
```

### Template Features

- **Placeholders** — text objects can be marked as placeholders with keys like `{{headline}}`, `{{source}}`, `{{logo}}`. When loading a template, these are highlighted for the user to fill in.
- **Thumbnail generation** — when saving a template, export canvas at reduced resolution (300x300) as PNG, upload to S3 for preview.
- **Categories** — news_card, quote, promo, announcement, before_after, story, carousel, custom.
- **Search** — by name and category, filtered by global + user's org.

### Template Flow

1. **Browse** — left sidebar Templates panel shows grid of thumbnails
2. **Apply** — click template → loads Fabric.js JSON onto canvas, placeholders highlighted in blue
3. **Edit** — click any element to modify, replace placeholder text/images
4. **Save** — "Save as Template" → enter name, pick category → serializes canvas JSON + generates thumbnail → saves to DB

## API Endpoints

### tRPC Router: `designTemplate`

```
designTemplate.list       — list templates (global + org), filter by category
designTemplate.getById    — get single template with canvasJson
designTemplate.create     — save new template (canvasJson, name, category, thumbnail)
designTemplate.update     — update existing template
designTemplate.delete     — delete template (org-owned only, not global)
```

### Custom Font Upload

```
media.uploadFont          — upload .ttf/.otf/.woff2 to S3, return URL
media.listFonts           — list uploaded custom fonts for org
```

## File Structure

```
apps/web/components/media-editor/
├── MediaEditor.tsx              — main editor wrapper, manages Fabric.js canvas lifecycle
├── FabricCanvas.tsx             — canvas component, init/destroy, object events
├── EditorSidebar.tsx            — left sidebar with icon strip
├── panels/
│   ├── TemplatePanel.tsx        — template browser grid
│   ├── ElementsPanel.tsx        — shapes, lines, frames, stickers
│   ├── TextPanel.tsx            — text presets, font picker
│   ├── UploadsPanel.tsx         — file upload, media library
│   ├── DrawPanel.tsx            — drawing tool controls
│   └── AIPanel.tsx              — AI edit prompt, bg removal, style transfer
├── toolbars/
│   ├── EditorToolbar.tsx        — contextual toolbar switcher
│   ├── TextToolbar.tsx          — text formatting options
│   ├── ShapeToolbar.tsx         — shape styling options
│   ├── ImageToolbar.tsx         — filters, crop, flip
│   └── CanvasToolbar.tsx        — canvas size, background, zoom
├── LayerPanel.tsx               — layers list with reorder/visibility/lock
├── BottomBar.tsx                — undo/redo, zoom slider
├── ColorPicker.tsx              — solid + gradient color picker
├── FontPicker.tsx               — font family selector with preview
├── FilterPresets.tsx            — preset filter thumbnails
└── hooks/
    ├── useFabricCanvas.ts       — canvas initialization, event handlers
    ├── useEditorHistory.ts      — undo/redo state management
    ├── useCanvasExport.ts       — export to PNG/JPG/base64
    └── useTemplates.ts          — template CRUD operations

packages/api/src/routers/
├── design-template.router.ts   — template CRUD endpoints

packages/db/prisma/
├── schema.prisma                — DesignTemplate model added
```

## Integration Points

### ComposeTab Changes

1. Add "Create Design" button next to "Add to Post" in AI image section
2. Add "Edit" overlay button on each image in `postMedia[]` grid
3. When editor opens: hide content editor area, show `<MediaEditor />` in its place
4. When editor closes: restore content editor, update `postMedia[]` with edited image
5. Right column (post preview) stays visible and updates live as canvas changes

### Existing API Reuse

- `image.edit` mutation — already exists for Gemini-powered image editing, reuse for AI edit prompts
- `image.saveGenerated` mutation — reuse for "Save to Library"
- `media.list` query — reuse for media library browsing in Uploads panel
- S3 upload utilities — reuse existing upload functions for template thumbnails and custom fonts

## Dependencies

- `fabric` (v6+) — MIT licensed, ~300KB, canvas manipulation library
- No other new dependencies required — AI editing reuses existing Gemini integration

## Media Persistence with Posts

Currently `postMedia[]` stores base64 data URLs in React state. This needs fixing for the editor:

### In-Memory: Use Blob URLs

- When the editor exports a canvas, create a Blob and use `URL.createObjectURL(blob)` instead of base64
- This avoids 5-10MB base64 strings in React state causing memory pressure
- Convert to base64/upload only at submit time

### On Post Submit: Upload to S3

When `createPost` is called:
1. For each item in `postMedia[]`, upload the blob/base64 to S3 via existing media upload utilities
2. Create Media records in the database with the S3 URLs
3. Link Media records to the Post via PostMedia join table
4. This aligns with how AI-generated images are already saved via `image.saveGenerated`

The `createPost` mutation needs to accept `mediaFiles` (base64 strings or S3 URLs) and handle the upload + linking server-side.

## Editor Layout Behavior

When the editor opens, it takes over the **full left column** of ComposeTab (replacing the Content Editor, AI Image Generation, Channel Selection, and Schedule cards). The editor needs the full width for its left sidebar + canvas layout.

The **right column (400px post preview)** remains visible. `PostPreviewSwitcher` already accepts `mediaUrls` — the editor periodically exports a low-res preview thumbnail (debounced, every 500ms on canvas change) and passes it to the preview via a callback prop `onPreviewUpdate(thumbnailUrl)`.

When the editor closes ("Apply to Post" or "Cancel"), the full compose view is restored.

### Unsaved Changes Protection

When the user clicks "Cancel" or navigates away with unsaved editor changes, show a confirmation dialog: "You have unsaved changes. Discard?" with "Keep Editing" and "Discard" buttons.

## Template Placeholders

Placeholders are implemented as a custom Fabric.js property on text objects:

```javascript
textObject.set('isPlaceholder', true);
textObject.set('placeholderKey', 'headline'); // or 'source', 'body', etc.
```

When loading a template:
1. Deserialize Fabric.js JSON
2. Find all objects with `isPlaceholder: true`
3. Highlight them with a dashed blue border and placeholder label
4. User clicks a placeholder to edit — the highlight clears once content is modified

Placeholder keys are freeform strings, not a fixed schema. Common conventions: `headline`, `subheading`, `body`, `source`, `logo`, `image`.

## Font Preloading for Templates

When loading a template that uses custom fonts:
1. Parse the Fabric.js JSON to extract all font family names
2. Query `media.listFonts` to get S3 URLs for each custom font
3. Load fonts via `FontFace` API and add to `document.fonts`
4. Only after all fonts are loaded, deserialize the Fabric.js JSON onto the canvas

This prevents text rendering with fallback fonts on initial load.

## Magic Eraser Interaction

1. User clicks "Magic Eraser" in AI panel
2. Canvas switches to a brush selection mode — user paints over the area to erase (red semi-transparent overlay)
3. On "Apply", the painted region is exported as a mask (black/white image)
4. The mask + original image are sent to Gemini with prompt: "Remove the content in the masked area, fill with appropriate background"
5. Result replaces the original image layer

## Error Handling for AI Edits

- **Loading state:** Show a spinner overlay on the canvas with "AI is editing..." message
- **Timeout:** 30-second timeout, show "AI edit took too long. Try again?" with retry button
- **API error:** Toast notification with error message, canvas remains unchanged
- **Rate limit:** Toast: "Too many AI edits. Please wait a moment." with countdown

## Canvas Constraints

- **Maximum canvas size:** 4096x4096 pixels (browser canvas limit)
- **Export quality:** PNG at 1x resolution for posts, JPG at 0.8 quality for thumbnails
- **Maximum export file size:** 10MB (compress or reduce resolution if exceeded)
- **Default canvas sizes:** 1080x1080 (Instagram), 1200x628 (Facebook/Twitter), 1080x1920 (Story)

## New Endpoints to Build

These endpoints do not exist yet and must be created:

- `media.uploadFont` — new, accepts .ttf/.otf/.woff2 file, uploads to S3, returns URL + font family name
- `media.listFonts` — new, lists all custom fonts for the organization
- `designTemplate.*` — all template CRUD endpoints are new

## Deferred to v2

- Curved text (requires custom Fabric.js class — complex implementation)
- Video editing
- Collaborative real-time editing
- Animation/motion graphics
- PDF export
- Brand kit integration (pull logo, colors, fonts from brand settings)
- Keyboard accessibility for canvas object navigation
