# cc-work design contract

Source: https://www.figma.com/design/ULzSTHZS6fW3uT08eBUcNe/cc-work-Product-UI

This is a design handoff for the replacement cc-work UI. The existing AWF application is not migrated or wired to these styles in this change.

## Tokens

150 Figma variables across Primitives, Theme (Dark), Layout and Typography. Semantic variables alias primitives. All have explicit scopes and WEB syntax `var(--cc-...)`.

`cc-work.tokens.json` is a compact export: each row is `[Figma variable ID, name, type, value-or-alias]`. `cc-work.tokens.css` uses the same names and aliases. `cc-work.layout.css` demonstrates the layout contract. Breakpoints in media queries are literal values because standard CSS custom properties cannot be used in media conditions.

Text styles: Display 20/26, Heading 15/20, Body 13/19, Body Medium 13/19, Caption 11/15, Mono 10/15. UI font: SF Pro with system and Chinese fallbacks. Mono: Roboto Mono with system fallback. Modal effect style uses the existing 0 16 34 0 shadow and 42% black.

## Reuse

Shared sidebar (populated and empty), topbar, view rail and status bar are Figma components. Complete screens use instances. Text properties on topbar/statusbar expose contextual data. Project lists remain example content, not production data contracts.

Plan and logs are slot-only views inside 1440 × 900 review frames. Their unused regions deliberately stay blank. The application supplies the shared shell; do not implement duplicate shells or the blank area as a product element.

## Confirmed scope

| View | Figma node | This revision |
| --- | --- | --- |
| Main workspace | 1:32 | Shared shell instances, tokens, auto-height messages |
| Settings | 8:2 | Confirmed; 1440 × 900; scrolling settings body |
| Plan | 10:2 | Only Plan draft panel; remaining area blank; visual refinement deferred |
| Run logs | 10:618 | Only log view and controls; no copy-event or selected-event functionality |
| Agent logs | 119:353 | Separate execution-output example; fields remain provisional |
| Decisions | 10:926 | Adopt or provide another decision; no independent reject action |
| Empty workspace | 21:2 | Confirmed; shared empty sidebar and status bar |
| Add project | 22:2 | Confirmed; shared shell; centered responsive modal |
| Conversation specimen | 93:2 | Current content accepted; 760 × 824 content slot |
| Alternative decision, empty | 120:352 | Replacement is required; submit disabled |
| Alternative decision, ready | 123:486 | Replacement provided; submit enabled |
| Workspace at 1024 | 121:352 | Narrow panel and reflowed messages |
| Add project at 390 | 121:675 | Single-column modal with 16 px side margins |

Protected and intentionally untouched: task execution drafts 10:310 and 15:2, and final archive 32:2. They retain 1600 × 1000 dimensions. This explicit preservation overrides the general size normalization.

Log examples are not confirmed payload schemas. Run illustrates orchestration events; Agent illustrates execution output. The user has not supplied definitive fields. Preserve this pending status when implementing.

The alternative-decision prototype demonstrates the empty and filled states. Clicking the example input shows a filled example; it does not collect actual text. Submission is not connected to a backend and must atomically reject the original proposal and record the supplied alternative in the implementation. Trimmed empty input must remain invalid.

## Responsive contract

Base review size: 1440 × 900. Sidebar 240; topbar 52; status bar 24; rail 48; panel 392. Height follows the viewport. Flex children have min-width/min-height zero; content regions scroll independently. Typography is not scaled with the frame.

- At 1024–1279, panel width is 320 and secondary status metrics are hidden.
- At 768–1023, sidebar becomes a drawer and the side panel opens as a separate view.
- Below 768, use compact navigation and a single content column. Dialog width is at most 520 with 16 px viewport margins.
- Long prose wraps; terminal/log rows scroll horizontally within the log area.
- Coarse-pointer controls have at least 44 px hit targets. Keyboard focus uses the info-color outline.

Figma Auto Layout supports resizing within a layout. CSS media queries and application state must implement breakpoint-driven drawer/navigation/panel changes; the static Figma frames do not run media queries.

## Validation

Screenshots reviewed for all changed desktop views and the two responsive examples. Width audit checks visible vertical-layout children against available content width. Non-scroll message containers use content-driven height; log, settings and message streams intentionally clip and scroll.

Visual reflow was corrected for Plan metadata, log controls, decision details and narrow message cards. Existing deferred designs and the final archive were excluded from modifications. Further work: confirm actual log schemas, refine the Plan draft, and redesign task execution views.
