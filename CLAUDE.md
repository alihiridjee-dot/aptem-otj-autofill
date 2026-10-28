# Aptem OTJ Autofill: project context

A Tampermonkey userscript (`aptem-otj-autofill.user.js`) for Anglia Ruskin medical students. It is shared with classmates, so keep it to a single file that installs with one click.

## What it does
1. **Canvas** (`canvas.anglia.ac.uk/courses/*/pages/*`): parses the weekly timetable page and stores the sessions with `GM_setValue`.
   - The page title looks like `NEUROLOGY: TIMETABLE WK 4 (28.09.26 - 02.10.26)`.
   - A `WEEKLY THEME: …` heading may be followed by more theme headings.
   - Each day heading looks like `Monday 28th September 2026`, followed by a table with the columns Time | Session Title | Presenter | Delivery | Recordings.
   - Lunch rows are skipped.
2. **Aptem** (`*.aptem.co.uk`): an "OTJ fill" button opens a panel.
   - The user unticks missed sessions.
   - DeepSeek (`deepseek-chat`, the user's own API key, stored per browser) suggests self-managed learning (SML) topics to top the week up to **37:30**. SML is never on the timetable; it is always the remainder.
   - The panel then fills the **Add Note** form:
     - Note type `Other`
     - Completion date dd/mm/yyyy (default: the week's last session)
     - Hours collection type: radio `Off The Job Training hours`
     - Off-The-Job Hours Spent `37:30`
     - Off-The-Job Hours Type: closest match to "paid in my own time"
     - Notes textarea: the built note text

## Note builder page (`otj-note-builder.html`)
A second, install-free route that works on any browser including iPad Safari.
- The user pastes the Canvas timetable. The HTML clipboard is parsed with the same walk as `parseCanvasTimetable`, with a tab-separated plain-text fallback.
- Weeks and settings live in `localStorage`. DeepSeek is called with `fetch` (browser CORS not yet confirmed).
- **Copy for autofill** copies `OTJ-AUTOFILL:{json}`. The **OTJ fill** bookmarklet is built from `otjAutofill.toString()`. It reads the clipboard (or prompts for a paste) and fills the form.
- `otjAutofill` must stay self-contained: it can't use anything outside its own body.
- The pure helpers and Aptem fill code are copied from the userscript. Keep both copies in sync.
- Tested against a mock Add Note form only.

## Rules
- Never click Aptem's Save. The user reviews and saves; these are audited funding records.
- Send DeepSeek only session titles and the theme. No presenter names, rooms or personal data.
- Build UI with the `h()` helper (textContent only). Never use innerHTML with page data.

## Status
- The pure helpers are unit-tested: `node test/pure.test.js`.
- The DOM code for Canvas and Aptem was written from screenshots and has **not yet been checked against the live pages**. Aptem's form may use Kendo UI widgets, which is why `setDropdown`, `setDate` and the masked hours box have Kendo fallbacks.
- **Next step:** check against the real pages, or against form HTML the user pastes in from the panel's "Copy form HTML" button.
