// ===================================================================
// API LAYER FOR THE VERCEL FRONTEND — additive, same pattern as
// Feedback.gs / VolunteerBackend.gs. Nothing in the other files had to
// be rewritten for this.
//
// HOW IT WORKS
// The HTML pages (now hosted on Vercel) used to call server functions
// with google.script.run.someFunction(a, b, c). The frontend now loads
// gas-shim.js, which provides an identical google.script.run that sends
//     POST <exec-url>   body: {"fn":"someFunction","args":[a,b,c]}
// to doPost() below. doPost() calls the SAME function with the SAME
// positional arguments and returns its result as JSON:
//     {"ok":true,"data":<whatever the function returned>}
//     {"ok":false,"error":"<message>"}
// So every existing function (checkLogin, getDashboardData,
// submitCompanyFeedback, ...) keeps working without any change.
//
// SETUP: put your Vercel URL in FRONTEND_URL_ below, then
// Deploy > Manage deployments > Edit > New version.
// ===================================================================

// Your Vercel site, e.g. 'https://my-placement-app.vercel.app'.
// All links the app generates (registration, test, feedback, kiosk,
// check-in, volunteer portal, employer feedback, photo upload) are built
// from this by getWebAppUrl_() in Code.gs. Leave '' to keep the old
// Apps Script links.
const FRONTEND_URL_ = '';

const API_GLOBAL_ = (typeof globalThis !== 'undefined') ? globalThis : this;

// Functions that must NEVER be callable from the browser: entry points,
// triggers, and maintenance/one-off utilities meant to be run from the
// Apps Script editor only. (Before, setAdminPassword/addAdmin could be
// invoked by anyone holding the web app link through google.script.run;
// blocking them here closes that.)
const API_BLOCKED_ = {
  doGet: 1, doPost: 1, include: 1, onEdit: 1, onOpen: 1,
  setAdminPassword: 1, addAdmin: 1,
  setupSheets: 1, migrateToPerCompanySheets: 1,
  authorizeDriveAccess: 1, authorizeMail: 1,
  repairTeamMembersColumn: 1, findDuplicateStudentsMasterRows: 1,
  backfillVolunteerPool: 1, backfillRoundStudentData: 1,
  repairPhotoStatusFromLinks: 1, cleanupOrphanedVolunteerAssignments: 1,
  runRoundVolunteerCompanyRepairReport: 1,
  debugCompanyRow: 1, debugPhotoLookup: 1, debugAdminRoundSync: 1
};

function apiJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    const req = raw ? JSON.parse(raw) : {};
    const fn = String(req.fn || '');
    const args = Array.isArray(req.args) ? req.args : [];

    // Letters/digits only; trailing "_" (private helper) never matches.
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(fn)) throw new Error('Invalid function name.');
    if (API_BLOCKED_[fn]) throw new Error('This function is not available from the web.');

    const target = API_GLOBAL_[fn];
    if (typeof target !== 'function') throw new Error('Unknown function: ' + fn);
    // Refuse built-ins such as eval / Function / parseInt: only functions
    // written in this project are callable.
    if (/\[native code\]/.test(Function.prototype.toString.call(target))) {
      throw new Error('Unknown function: ' + fn);
    }

    const result = target.apply(null, args);
    return apiJson_({ ok: true, data: (result === undefined ? null : result) });
  } catch (err) {
    return apiJson_({ ok: false, error: String((err && err.message) || err) });
  }
}

// Replaces the values doGet() used to inject into Checkin.html via the
// template (checkinTmpl.eligibleBranches). The page now calls this after
// loading, passing the session id from its URL.
function getCheckinPageContext(sessionId) {
  try {
    const session = sessionId ? findAttendanceSessionRow_(sessionId) : null;
    return {
      success: true,
      eligibleBranches: session ? getEligibleBranchesForCompany_(session.Company_Name) : []
    };
  } catch (err) {
    return { success: false, message: err.message, eligibleBranches: [] };
  }
}

// ===================================================================
// TWO FUNCTIONS THE ADMIN PAGE (Index.html) ALREADY CALLED BUT THAT WERE
// MISSING FROM THE BACKEND, which produced the red toast
// "Unknown function: getRegisteredStudentEditFields".
// Both are read-only and built purely from existing functions.
// ===================================================================

// The "extra fields" shown in the Edit Registered Student form and in
// "Add Manually" for a round: whatever this company's registration form
// collects beyond the base columns (Aadhar, DOB, Course, 10th/12th %,
// custom questions...) plus any extra columns that came from a CSV/Excel
// upload. Same list the Download picker uses, minus the base columns,
// attendance, and the CV link columns.
function getRegisteredStudentEditFields(companyName) {
  try {
    const res = getRegisteredStudentDownloadFields(companyName);
    if (!res || !res.success) return res || { success: false, message: 'Could not load fields.' };
    const skip = { Display_Email: true, CV_File_Name: true, CV_File_URL: true };
    REGISTERED_STUDENTS_HEADERS.forEach(h => { skip[h] = true; });
    return { success: true, fields: (res.fields || []).filter(f => !skip[f.key]) };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Fresh list of this company's Selected Students (same merged records the
// company detail page shows), used to refresh that list after a push.
function getSelectedStudentsForCompany(companyName) {
  try {
    const d = getCompanyDetails(companyName);
    if (!d || !d.success) return d || { success: false, message: 'Could not load selected students.' };
    return { success: true, students: d.students || [] };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
