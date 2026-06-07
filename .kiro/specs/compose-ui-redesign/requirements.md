# Requirements Document

## Introduction

Redesign the compose/reply UI in the email-catcher site (`DraftSignalCard.vue`). The current editor offers a plain markdown textarea with Edit/Preview toggle and a single Send button. This feature replaces that with a dual-mode editor (markdown source vs WYSIWYG), a split send button with multiple dispatch actions, inline image paste/drop support, and formatting keyboard shortcuts — all inline within the thread view.

## Glossary

- **Compose_Editor**: The editing component within `DraftSignalCard.vue` that accepts user-authored email body content
- **Markdown_Mode**: Editing mode that displays raw markdown source in a monospace textarea with syntax-wrapping keyboard shortcuts
- **Formatted_Mode**: Editing mode that renders a WYSIWYG rich-text surface (Tiptap/ProseMirror) and serializes content to/from markdown
- **Mode_Toggle**: A segmented control that switches the Compose_Editor between Markdown_Mode and Formatted_Mode
- **Split_Send_Button**: A compound button with a primary action (Send + Archive) and a dropdown menu exposing secondary send actions
- **Send_Dropdown**: The menu portion of the Split_Send_Button containing secondary dispatch actions
- **Attachment_Endpoint**: The backend `POST /accounts/:id/attachments` route that accepts file uploads and returns a URL
- **Schedule_Endpoint**: The backend `POST /accounts/:id/signals/:signalId/schedule` route that queues a signal for future delivery
- **Reminder_Endpoint**: The backend `POST /accounts/:id/arcs/:arcId/reminders` route that creates a follow-up reminder
- **Upload_Placeholder**: A transient inline element shown in the editor body while an image upload is in flight
- **Time_Picker**: A date/time selection UI used by Schedule and Remind Me actions

## Requirements

### Requirement 1: Dual-mode editor with toggle

**User Story:** As a user composing a reply, I want to switch between raw markdown editing and a formatted WYSIWYG view, so that I can use whichever mode suits my comfort level without losing content.

#### Acceptance Criteria

1. THE Compose_Editor SHALL display a Mode_Toggle with two options: "Markdown" and "Formatted"
2. WHEN the user selects "Markdown" in the Mode_Toggle, THE Compose_Editor SHALL render a monospace textarea containing the raw markdown source of the email body
3. WHEN the user selects "Formatted" in the Mode_Toggle, THE Compose_Editor SHALL render a Tiptap/ProseMirror WYSIWYG surface that displays the body as rendered rich text
4. WHEN the user switches from Formatted_Mode to Markdown_Mode, THE Compose_Editor SHALL serialize the Tiptap document to CommonMark markdown and populate the textarea with the result, preserving all text content, links, images, lists, headings, and inline formatting present in the document
5. WHEN the user switches from Markdown_Mode to Formatted_Mode, THE Compose_Editor SHALL parse the textarea markdown into a Tiptap document and render the WYSIWYG surface with the result; any markdown constructs not supported by the Tiptap schema SHALL be rendered as literal text rather than discarded
6. THE Mode_Toggle SHALL replace the existing Edit/Preview tab pair — the Preview tab is removed
7. THE Compose_Editor SHALL persist the user's last-selected mode in localStorage so it is restored on next compose
8. IF localStorage is unavailable or contains no prior mode selection, THEN THE Compose_Editor SHALL default to Formatted_Mode
9. IF the markdown textarea content cannot be parsed into a valid Tiptap document, THEN THE Compose_Editor SHALL remain in Markdown_Mode and display an inline error message indicating which line could not be parsed

### Requirement 2: Markdown-mode formatting shortcuts

**User Story:** As a power user writing in raw markdown, I want keyboard shortcuts that wrap my selection with formatting syntax, so that I can apply bold, italic, link, and strikethrough without typing delimiters manually.

#### Acceptance Criteria

1. WHILE the Compose_Editor is in Markdown_Mode and the textarea is focused, THE Compose_Editor SHALL intercept Ctrl+B and wrap the current selection with `**` (bold)
2. WHILE the Compose_Editor is in Markdown_Mode and the textarea is focused, THE Compose_Editor SHALL intercept Ctrl+I and wrap the current selection with `_` (italic)
3. WHILE the Compose_Editor is in Markdown_Mode and the textarea is focused, THE Compose_Editor SHALL intercept Ctrl+K and wrap the current selection with `[selection](url)` placing the cursor inside the `url` placeholder
4. WHILE the Compose_Editor is in Markdown_Mode and the textarea is focused, THE Compose_Editor SHALL intercept Ctrl+Shift+X and wrap the current selection with `~~` (strikethrough)
5. WHEN no text is selected and a formatting shortcut is pressed, THE Compose_Editor SHALL insert the opening and closing delimiters and place the cursor between them
6. WHEN the characters immediately before and after the selection match the corresponding formatting delimiter, THE Compose_Editor SHALL remove those delimiters instead of adding new ones (toggle off)
7. WHILE the Compose_Editor is in Markdown_Mode, THE Compose_Editor SHALL use Cmd instead of Ctrl for all formatting shortcuts when running on macOS
8. WHEN a formatting shortcut is intercepted, THE Compose_Editor SHALL prevent the browser default action for that key combination
9. WHEN the selection spans multiple lines and a formatting shortcut other than Ctrl+K is pressed, THE Compose_Editor SHALL wrap the entire multi-line selection with a single pair of delimiters

### Requirement 3: Formatted-mode native shortcuts

**User Story:** As a user editing in WYSIWYG mode, I want the same keyboard shortcuts to apply inline formatting natively, so that muscle memory transfers between modes.

#### Acceptance Criteria

1. WHILE the Compose_Editor is in Formatted_Mode, WHEN the user presses Ctrl+B, THE Tiptap editor SHALL toggle the bold mark on the selected text, or if no text is selected, toggle bold for subsequently typed characters at the cursor position
2. WHILE the Compose_Editor is in Formatted_Mode, WHEN the user presses Ctrl+I, THE Tiptap editor SHALL toggle the italic mark on the selected text, or if no text is selected, toggle italic for subsequently typed characters at the cursor position
3. WHILE the Compose_Editor is in Formatted_Mode, WHEN the user presses Ctrl+K and text is selected, THE Tiptap editor SHALL open a link input prompt and apply the entered URL as a link mark to the selected text
4. IF the user presses Ctrl+K in Formatted_Mode with no text selected, THEN THE Tiptap editor SHALL not open the link input prompt and SHALL leave the editor state unchanged
5. IF the user cancels or dismisses the link input prompt without entering a URL, THEN THE Tiptap editor SHALL close the prompt, preserve the existing selection, and not apply a link mark
6. WHILE the Compose_Editor is in Formatted_Mode, WHEN the user presses Ctrl+Shift+X, THE Tiptap editor SHALL toggle the strikethrough mark on the selected text, or if no text is selected, toggle strikethrough for subsequently typed characters at the cursor position
7. WHILE the Compose_Editor is running on macOS, THE Tiptap editor SHALL use the Cmd modifier in place of Ctrl for all formatting shortcuts defined in criteria 1 through 6

### Requirement 4: Split send button with primary action

**User Story:** As a user, I want the primary send action to send the email and archive the arc in one click, so that my inbox stays clean after replying.

#### Acceptance Criteria

1. THE Split_Send_Button SHALL display "Send + Archive" as its primary (left) label
2. WHEN the user clicks the primary portion of the Split_Send_Button, THE Compose_Editor SHALL persist the draft, invoke the send endpoint, enter the existing 30-second cancellation window, and — only after the cancellation window expires without undo — transition the parent arc to `status: "archived"` via `PATCH /arcs/:arcId`
3. IF the user cancels the send during the cancellation window, THEN THE Compose_Editor SHALL NOT archive the arc and SHALL revert the signal to draft status
4. IF the archive request fails after a successful send, THEN THE Compose_Editor SHALL display an inline error message indicating the arc could not be archived, but SHALL NOT roll back the sent email
5. WHEN the user clicks the dropdown chevron (right portion) of the Split_Send_Button, THE Split_Send_Button SHALL open the Send_Dropdown menu
6. WHEN the Send_Dropdown is open and the user clicks outside the dropdown or presses Escape, THE Send_Dropdown SHALL close
7. THE Split_Send_Button SHALL be disabled when `sendState` is not `idle`, or the from address is empty, or the subject is empty (whitespace-only counts as empty), or the body is empty (whitespace-only counts as empty)

### Requirement 5: Send + Remind Me action

**User Story:** As a user, I want to send an email and immediately set a follow-up reminder, so that I don't forget to check for a response.

#### Acceptance Criteria

1. THE Send_Dropdown SHALL include a "Send + Remind Me" option
2. WHEN the user selects "Send + Remind Me", THE Compose_Editor SHALL display a Time_Picker allowing the user to select a reminder date and time no earlier than 1 hour in the future and no later than 90 days in the future
3. WHEN the user confirms the reminder time, THE Compose_Editor SHALL persist the draft, invoke the send endpoint, archive the arc, and then call the Reminder_Endpoint with the selected `remindAt` timestamp for the parent arc
4. IF the send endpoint returns an error, THEN THE Compose_Editor SHALL display an inline error message indicating the send failed, retain the draft, and NOT invoke the Reminder_Endpoint
5. IF the Reminder_Endpoint returns an error, THEN THE Compose_Editor SHALL display an inline error message indicating the reminder was not set but the email was sent successfully, and SHALL NOT roll back the send
6. IF the user dismisses the Time_Picker without confirming a time, THEN THE Compose_Editor SHALL return to its previous state without sending the email or scheduling a reminder

### Requirement 6: Schedule send action

**User Story:** As a user, I want to schedule an email for future delivery without sending it now, so that I can compose messages outside business hours and have them arrive at an appropriate time.

#### Acceptance Criteria

1. THE Send_Dropdown SHALL include a "Schedule" option
2. WHEN the user selects "Schedule", THE Compose_Editor SHALL display a Time_Picker that allows the user to select a future date and time in the user's local timezone, with minute-level granularity, within a range of 1 minute to 30 days from the current time
3. WHEN the user confirms the scheduled time, THE Compose_Editor SHALL persist the draft and call the Schedule_Endpoint with the selected `sendAt` timestamp
4. IF the selected time is less than 1 minute from the current time, THEN THE Time_Picker SHALL prevent confirmation and display a validation message indicating the time must be at least 1 minute in the future
5. WHEN the Schedule_Endpoint returns success, THE Compose_Editor SHALL emit a `sent` event so the parent thread can refresh and show the scheduled state
6. IF the Schedule_Endpoint returns an error, THEN THE Compose_Editor SHALL display an inline error message and keep the draft editable
7. WHEN the user dismisses the Time_Picker without confirming a time, THE Compose_Editor SHALL close the Time_Picker and return to the compose state without persisting or scheduling

### Requirement 7: Discard action in dropdown

**User Story:** As a user, I want the discard action grouped with the other send actions, so that all compose disposition options are in one place.

#### Acceptance Criteria

1. THE Send_Dropdown SHALL include a "Discard" option visually separated from the send-related actions (divider line above it)
2. WHEN the user selects "Discard", THE Compose_Editor SHALL call the `deleteDraftSignal` endpoint and, on success, emit a `discard` event without displaying a confirmation dialog
3. IF the `deleteDraftSignal` endpoint returns an error, THEN THE Compose_Editor SHALL display an inline error message and keep the draft editable
4. THE standalone "Discard draft" text link currently below the Send button SHALL be removed

### Requirement 8: Inline image paste

**User Story:** As a user composing an email, I want to paste or drop images directly into the editor, so that I can include screenshots and photos without a separate attachment workflow.

#### Acceptance Criteria

1. WHEN a paste event containing image data (File with MIME type `image/*`) occurs in the Compose_Editor, THE Compose_Editor SHALL extract the File from the clipboard
2. WHEN a drop event containing image files occurs in the Compose_Editor, THE Compose_Editor SHALL extract up to 10 File(s) from the DataTransfer and discard any beyond that limit
3. WHEN an image File is extracted, THE Compose_Editor SHALL insert an Upload_Placeholder at the current cursor position within 200ms, displaying the file name and a progress indicator
4. WHEN an image File is extracted, THE Compose_Editor SHALL upload the File to the Attachment_Endpoint using a multipart/form-data request
5. IF the extracted image File exceeds 10 MB in size, THEN THE Compose_Editor SHALL reject the file without uploading, remove the Upload_Placeholder, and display a toast notification indicating the size limit was exceeded
6. WHEN the Attachment_Endpoint returns success with a URL, THE Compose_Editor SHALL replace the Upload_Placeholder with the appropriate inline image syntax: `![filename](url)` in Markdown_Mode, or an `<img>` node in Formatted_Mode
7. IF the Attachment_Endpoint returns an error or the upload does not complete within 30 seconds, THEN THE Compose_Editor SHALL replace the Upload_Placeholder with an error indicator and display a toast notification indicating the failure reason
8. WHILE an upload is in flight, THE Upload_Placeholder SHALL display a percentage progress indicator when the upload size is deterministic, or an indeterminate spinner otherwise

### Requirement 9: Drag-and-drop image support

**User Story:** As a user, I want to drag image files from my desktop into the compose editor, so that I can attach images using the most natural interaction for my platform.

#### Acceptance Criteria

1. WHEN a file is dragged over the Compose_Editor area, THE Compose_Editor SHALL display a visual drop zone indicator (border highlight or overlay)
2. WHEN the drag leaves the Compose_Editor area without a drop, THE Compose_Editor SHALL remove the drop zone indicator
3. WHEN one or more files are dropped onto the Compose_Editor, THE Compose_Editor SHALL filter the dropped files to those with a MIME type matching `image/*`, process up to 10 image files using the same upload-and-insert flow defined in Requirement 8, and silently discard any non-image files without displaying an error
4. IF a drop event contains no files with a MIME type matching `image/*`, THEN THE Compose_Editor SHALL ignore the drop and remove the drop zone indicator without inserting content or displaying an error
5. WHEN a valid drop event is accepted, THE Compose_Editor SHALL remove the drop zone indicator immediately upon processing the drop (before uploads begin)

### Requirement 10: Editor content round-trip fidelity

**User Story:** As a developer, I want switching between Markdown_Mode and Formatted_Mode to preserve the user's content faithfully, so that no formatting is silently lost during mode transitions.

#### Acceptance Criteria

1. THE Compose_Editor SHALL produce a semantically equivalent markdown string after a Markdown→Formatted→Markdown round trip for content containing any combination of: headings (levels 1–6), bold, italic, strikethrough, inline code, links, images, ordered lists, unordered lists, blockquotes, fenced code blocks, and horizontal rules — where "semantically equivalent" means the two markdown strings render to identical HTML output when parsed by the same markdown parser, regardless of differences in whitespace, list-marker characters, or emphasis-delimiter choice
2. THE Compose_Editor SHALL produce a semantically equivalent Tiptap document after a Formatted→Markdown→Formatted round trip — where "semantically equivalent" means both documents serialize to identical HTML via Tiptap's `getHTML()` method
3. IF the markdown contains syntax that Tiptap cannot represent (e.g. raw HTML, footnotes, or definition lists), THEN THE Compose_Editor SHALL preserve each unrecognized block as a raw text node containing the original source characters rather than discarding or transforming it
4. IF a round trip produces a non-equivalent result for any supported element listed in criterion 1, THEN THE Compose_Editor SHALL treat this as a bug — no silent content loss is acceptable and no user-facing degradation warning is required (the conversion must be fixed at the code level)
