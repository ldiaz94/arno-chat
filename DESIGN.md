# Interface design

The design treats remote coding as a workspace, rather than a raw terminal transcript.

## Visual system

- Dark slate surfaces with mint accents reserve the strongest contrast for actions and state.
- The system font stack loads without network requests and remains familiar on iOS.
- A 252px desktop sidebar becomes a mobile drawer; the conversation keeps a readable maximum width.
- Cards, borders, and restrained depth establish hierarchy without adding large illustrations.
- CSS variables define colors and surfaces for both dark and light themes.
- Small transitions respect prefers-reduced-motion.

## Reading and interaction

Assistant prose supports safe Markdown. Raw CLI setup banners move into collapsible execution details. Code blocks have language labels and copy buttons; code, tables, and diffs scroll inside their own boundaries.

The composer uses an explicit send button and Cmd/Ctrl+Enter. Enter alone adds a newline, which is useful for coding prompts on mobile. Drafts persist per session in the tab. The model dialog supports name/identifier search and Cmd/Ctrl+K.

Turn footers show completion, wall time, measured tokens, and list-price cost when available. Regular-chat messages have an Edit button; sending an edit replaces that message and the turns after it. Tables size to their content: short cells stay on one line, long ones wrap at about 40 characters, wide tables scroll inside their frame, and column edges can be dragged (double-click resets). The Usage & workspace dialog separates provider counters from phase timings and repository identity. Unknown statistics use a dash and explanatory text.

## Honest state

Repository search reports progress until all accessible pages have been scanned. Task activity distinguishes restoration, preparation, execution, and checkpointing. A warm workspace is labeled separately from a saved sleeping workspace.

The application does not invent account balances, token costs, live tool traces, or completion percentages. Phase steps show state progression, not estimated progress.

## Accessibility

Buttons have descriptive accessible names; decorative SVGs are hidden from assistive technology. Dialogs use native modal focus management and named headings. Focus outlines remain visible. Input text is at least 16px on mobile to avoid Safari zoom. Status toasts use role=status. Form actions use explicit buttons.

The automated design test covers widths down to 360px and reduced-height keyboard-style viewports. Actual mobile browsers remain part of release validation.

The suite also covers 1440px laptop/desktop, 2560px, and 3440px ultrawide layouts, a docked code pane, full-height mobile account settings, row-level conversation deletion, quiet regular-chat thinking, and citation previews.
