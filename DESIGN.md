# Vortex interface direction

## Product read

Vortex is an operator's media workstation, not a marketing landing page. Its primary job is to let a person inspect a source, understand what the extractor found, queue transfers, monitor durable work, manage local files, and configure delivery. The interface should feel like a precise instrument: calm at rest, legible under load, and explicit when an operation changes state.

## Visual direction: Field Notes / Signal Desk

A dark, warm, low-glare workspace with the restraint of a well-made audio or broadcast tool. Use ink-green charcoal for the ground, a slightly lighter mineral surface for working areas, warm near-white for primary text, and a single acid-lime signal color for the most important action and keyboard focus. Functional success, warning, and error colors may appear only when they communicate those states.

- Ground: #101411
- Raised surface: #191F1A
- Recessed surface: #0B0F0C
- Border: #303A31
- Primary text: #E8EDE4
- Secondary text: #A4AEA2
- Quiet text: #778276
- Signal accent: #C6F36A
- Success: #91C99B (state only)
- Warning: #E7BD72 (state only)
- Error: #E28B82 (state only)

Typography uses Instrument Sans for interface text and IBM Plex Mono for URLs, counts, timestamps, and machine output. Headlines are compact and confident, not oversized. Numeric data uses tabular figures. Avoid all-caps prose; small uppercase labels are reserved for real system metadata.

## Composition

- Keep the scraper workflow first: URL input and crawl controls are the primary working surface, with discovered media directly below.
- Queue is an operational ledger: current work is prominent, history is quiet, and progress is visible without decorative cards.
- Files are a practical library, not a gallery template.
- Telegram is a configuration panel with clear credential and connection states.
- Logs are a readable terminal feed with stable alignment and restrained syntax color.
- Use a consistent 14px working radius for major surfaces, 9px for controls, and 6px for compact metadata. Avoid turning every element into a pill.
- Surfaces are mostly flat. Elevation is reserved for overlays and the primary action; no blanket glow or frosted-glass treatment.
- Navigation stays compact and discoverable. On narrow screens it becomes a horizontally scrollable tab rail with comfortable touch targets.

## Liveliness dials

- ENERGY: 5/10 — confident and tactile, not loud.
- RHYTHM: 7/10 — vary the density between the input workspace, results, and operational lists; do not repeat identical card grids.
- MOTION: 3/10 — short state transitions and progress movement only. Respect reduced-motion preferences.

## Interaction contract

- Preserve every existing endpoint, callback, queue action, extraction path, and data shape.
- Every button has a clear hover, pressed, disabled, and keyboard-focus state.
- Inputs have visible labels, not placeholder-only identification.
- Empty, loading, active, success, and error states remain distinguishable without relying on color alone.
- Mobile is a real reflow: no horizontal page overflow, no clipped controls, and touch targets at least 44px.
- Never fabricate throughput, user counts, uptime, customer logos, or performance claims.
- Avoid generic AI language, decorative sparkle motifs, fake dashboards, unnecessary badges, and gradient-as-identity styling.

## Quality gate

Before shipping, run the repository type check and production build, Python compilation, and workspace integration tests. Inspect the UI at narrow, intermediate, and wide widths. Verify keyboard focus and reduced-motion behavior. Do not claim visual or live-deployment verification unless it was actually performed.


## Taste-skill refinement (11/11/2026)

Applied the design-taste-frontend principles to the existing operator workstation rather than treating Vortex as a marketing landing page:

- Keep the actual scraper UI as the product's primary visual; avoid stock photography, generic dashboard decoration, and invented metrics.
- Use one material system across the public workspace and private owner console: warm ink ground, mineral surfaces, restrained lime action colour, consistent borders and radii.
- Keep the active navigation state typographic and precise, with a small underline rather than a floating pill.
- Remove decorative gradients and heavy shadows from operational surfaces; retain colour only for meaningful status and the primary action.
- Tighten responsive spacing and control sizing while preserving the existing actions, API calls, queue behaviour, and extraction flow.
- Motion remains quiet and functional, with reduced-motion support.
