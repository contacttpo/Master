# Campus Placement Tracker - frontend + fast path

## What is in this folder (ALL of it goes to GitHub, except nothing is secret here)
- 10 pages (*.html), manifest.json, sw.js, icon-*.png, vercel.json, package.json
- gas-shim.js  (v4 - no longer needs editing)
- api/call.js, api/config.js, api/status.js   <- Vercel functions (fast path)
- lib/google.js, lib/ported.js                <- reads Google Sheets directly

## Vercel > Settings > Environment Variables (then Redeploy)
| Name | Value |
|---|---|
| GAS_URL | your Apps Script web app address (ends in /exec) |
| SHEET_ID | the long id in your Vikas MAster sheet's URL (between /d/ and /edit) |
| GOOGLE_CREDENTIALS | the full contents of the service-account JSON key file |

Also: Vercel > Settings > Functions > Function Region: Asia Pacific (Mumbai) bom1.

## Check it
- mastertpo.vercel.app/api/status             -> shows what is connected
- mastertpo.vercel.app/api/status?compare=1   -> runs each fast function on the new path AND on Apps Script,
                                                 says whether the answers are identical and how long each took
- mastertpo.vercel.app/?debug=1               -> timing panel (🚀 = fast path, ⚡ = instant from device)

## Safety
If any setting is missing or the fast path errors, the page automatically uses Apps Script as before.
Never commit the .gs files or the JSON key.
