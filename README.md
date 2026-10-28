# Aptem OTJ Autofill

Reads your weekly timetable from Canvas, tops it up to 37:30 with self-managed learning (SML) topics suggested by DeepSeek, and fills Aptem's **Add Note** form. It never presses Save: you check the form and save it yourself.

## Easiest: the note builder page (any browser, Mac or iPad)

`otj-note-builder.html` is a single page you open in a browser. Nothing to install.

1. **Canvas:** open the week's timetable, select the page content (title down to the last table) and copy it.
2. **Note builder:** paste it into box 1. Untick missed sessions, add SML topics (type them, or press **Suggest SML topics** if you've set a DeepSeek key in Settings), then **Build note**.
3. **Aptem:** either press **Copy note** and paste it into the Notes box yourself, or use autofill:
   - Set up the **OTJ fill** bookmark once (instructions on the page: drag it to the bookmarks bar on a Mac; on iPad, bookmark any page and replace its address with the copied code).
   - Press **Copy for autofill**, open the task on Aptem, choose the **OTJ fill** bookmark. If Safari asks to paste, allow it. If it can't read the clipboard it asks you to paste the text into a box.
4. Check every field in Aptem, then press **Save** yourself.

To use it on an iPad the page has to be hosted somewhere (an iPad can't run a downloaded HTML file).

## Alternative: the Tampermonkey userscript

Captures the timetable automatically when you open it on Canvas. Needs Tampermonkey, so it works on desktop Chrome, Edge, Firefox, and Safari (paid Tampermonkey); it won't run in the free Userscripts app or on iPad.

## Install (once)

1. Install the **Tampermonkey** extension for your browser (Chrome, Edge, Firefox or Safari).
2. In Chrome or Edge: open the extensions page, switch on **Developer mode**, then open Tampermonkey's details and switch on **Allow User Scripts**. (Chrome won't run user scripts without this.)
3. Open `aptem-otj-autofill.user.js` in the browser (or drag it onto a browser window). Tampermonkey shows an install page; click **Install**.

## Each week

1. **Canvas:** open that week's timetable page. A small box in the bottom-left confirms how many sessions and hours were captured.
2. **Aptem:** open the task you log hours against. Click the blue **OTJ fill** button in the bottom-right.
3. Untick any session you didn't attend.
4. Click **Suggest SML topics**. Edit the list so it matches what you'll actually revise. Each line is `hh:mm | topic`.
5. Click **Build note** and check the text. Then click **Fill Aptem form**. It clicks **+ Add Note** for you if the form isn't open.
6. Check every field in Aptem, then press **Save**.

## Settings (⚙ in the panel)

- **DeepSeek API key:** saved only in your own browser. Without it, type the SML topics in by hand; everything else still works.
- **Weekly hours target:** default `37:30`.
- **Note type** and **OTJ hours type:** the text of the option to pick. The closest match is chosen, and the status box shows which one was picked.

## If something doesn't fill

The status box lists each field with ✓ or ✗. For any ✗, fill that field by hand. To get it fixed, open the Add Note form, click **Copy form HTML** in the panel, and send what's copied to whoever maintains the script.
