# Campus Placement Tracker - release package

Everything in THIS folder goes to GitHub (Vercel publishes it). Never put the .gs files or the Google JSON key on GitHub.

## What is where
| Folder / file | What it is |
|---|---|
| *.html (10 pages) | the app screens; each loads /gas-shim.js first |
| gas-shim.js | sends every page call to Apps Script (or to the fast route), instant device cache, timing panel (?debug=1) |
| api/call.js | the fast route: answers ported read functions straight from Google Sheets |
| api/status.js | health + comparison page (/api/status and /api/status?compare=1) |
| api/config.js | gives pages your Apps Script address from the GAS_URL setting |
| lib/google.js, lib/ported.js, lib/regconst.js | Google Sheets reader, the rewritten functions, form option lists (ALL THREE must be in lib/) |
| manifest.json, sw.js, icon-*.png | makes the site installable as an app |
| vercel.json, package.json | Vercel settings (Node 24, Excel library) |

## Vercel > Settings > Environment Variables
| Name | Value |
|---|---|
| GAS_URL | Apps Script web app address (ends in /exec) |
| SHEET_ID | the long id in the sheet address (between /d/ and /edit) |
| GOOGLE_CREDENTIALS | full text of the service-account JSON key |
| FAST_EXTRA | the single word `all` once /api/status?compare=1 shows NOT_identical = none. Add `exportFormattedFile` too if you want Excel exports on the fast route: `all,exportFormattedFile` |
| PERMANENT_ADMIN_MOBILES | (optional) your two permanent admin mobiles, comma separated, only if you changed them in VolunteerBackend.gs |
| FRONTEND_URL | (optional) only if you add a custom domain |
Changing a setting needs a Redeploy.

## Apps Script (Extensions > Apps Script in the Vikas MAster sheet)
Files: Code.gs, Api.gs, EmployerFeedback.gs, Feedback.gs, VolunteerBackend.gs (all in apps-script/).
After pasting any of them: Deploy > Manage deployments > pencil > Version: New version > Deploy.

## Release checklist (tick each)
1. [ ] GitHub repo top level shows: the 10 .html files, gas-shim.js, manifest.json, sw.js, vercel.json, package.json, icon-*.png, folders api/ (3 files) and lib/ (3 files).
2. [ ] Vercel > Deployments: newest says Ready.
3. [ ] Apps Script: Api.gs and Code.gs replaced and a NEW VERSION deployed. Search Api.gs for `rollCallAssignStudentsBatch` - it must be found.
4. [ ] /api/status shows version v17-volunteer-overview and all four of GAS_URL_set, SHEET_ID_set, GOOGLE_CREDENTIALS_set, ready = true.
5. [ ] /api/status?compare=1&n=2  ->  NOT_identical: none.   (if not: send the `differences` text)
6. [ ] Set FAST_EXTRA = all (and exportFormattedFile if wanted), Redeploy.
7. [ ] Open the app with ?debug=1: the slow calls show a rocket and well under 1 second.
8. [ ] Clear old copies on phones: Chrome > Settings > Site settings > All sites > mastertpo.vercel.app > Clear & reset.

## If something goes wrong
- Fast route misbehaves: delete the FAST_EXTRA setting and Redeploy; everything goes back through Apps Script (slower, same results).
- A page misbehaves after an update: in GitHub open the file > History > restore the previous version.
- Apps Script change misbehaves: Deploy > Manage deployments > pencil > choose an older Version.
