# Deploy steps

## 1. Apps Script (backend)
1. In the Apps Script project, replace Code.gs with apps-script/Code.gs and add apps-script/Api.gs as a NEW file. The other three .gs files are unchanged.
2. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone. Copy the /exec URL.
3. Open <exec-url>?api=ping in a browser: you should see {"ok":true,"message":"API running"}.

## 2. This folder (the only thing that goes to GitHub)
- gas-shim.js: line 13, set API_URL to your /exec URL.
- All 10 pages are already converted (shim added, <?= ?> values replaced with URL parameters).
- Do NOT commit the .gs files (.gitignore already excludes them): Code.gs holds default admin passwords.

## 3. GitHub + Vercel
git init && git add . && git commit -m "init" && git branch -M main
git remote add origin <repo-url> && git push -u origin main
Vercel > Add New > Project > import the repo > Framework Preset: Other > Deploy.

## 4. Connect the links
Put the Vercel URL into FRONTEND_URL_ in Api.gs, then Deploy > Manage deployments > Edit > New version.
Existing is.gd short kiosk links still point at the old Apps Script URL: clear the Short_Kiosk_Url cells of open sessions or create new sessions.
