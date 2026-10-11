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
const FRONTEND_URL_ = 'https://mastertpo.vercel.app';

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

// ===================================================================
// FASTER "PULL PRESENT STUDENTS INTO ROUND"
// Same behaviour as pullPresentStudentsIntoRound in Code.gs (which is left untouched, so this can be
// switched back at any time). The original reads the round tab's header row three separate times and
// the rows once more; this reads the tab ONCE and reuses it. Fewer round trips to the sheet = faster.
// ===================================================================
function pullPresentStudentsIntoRoundFast(companyName, roundName, adminToken) {
  try {
    if (!companyName || !roundName) return { success: false, message: 'Company and round are required.' };
    const guard = requireRoundEditable_(companyName, roundName, adminToken);
    if (guard) return guard;
    const regSheet = getExistingRegisteredSheetForCompany_(companyName);
    const allRegistered = sheetObjectsFrom_(regSheet);
    const presentStudents = allRegistered.filter(r => normalizeStr_(r.Attendance).toUpperCase() === 'PRESENT');
    const skippedNoEnrollment = presentStudents.filter(s => !normalizeEnrollmentNo_(s.Enrollment_No)).length;
    const eligiblePresentStudents = presentStudents.filter(s => normalizeEnrollmentNo_(s.Enrollment_No));
    const roundSheet = getRoundSheetForCompany_(companyName);
    const addedCount = copyStudentsIntoRoundFast_(eligiblePresentStudents, roundSheet, companyName, roundName);
    return {
      success: true, count: addedCount, totalPresent: presentStudents.length,
      skippedNoEnrollment: skippedNoEnrollment
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function copyStudentsIntoRoundFast_(sourceRows, roundSheet, companyName, roundName) {
  if (!sourceRows || !sourceRows.length) return 0;
  const EXCLUDE_KEYS = { Company_Name: true, Round_Name: true, Result: true, Attendance: true, Check_In_Time: true };
  const extraKeys = {};
  sourceRows.forEach(r => Object.keys(r).forEach(k => { if (!EXCLUDE_KEYS[k]) extraKeys[k] = true; }));
  const expected = ROUND_STUDENTS_HEADERS.concat(
    Object.keys(extraKeys).filter(k => ROUND_STUDENTS_HEADERS.indexOf(k) === -1)
  );

  // ONE read of the whole tab: header row + existing rows.
  const lastRow = Math.max(roundSheet.getLastRow(), 1);
  const lastCol = Math.max(roundSheet.getLastColumn(), 1);
  const data = roundSheet.getRange(1, 1, lastRow, lastCol).getValues();
  const liveHeaders = data[0].slice();

  // Add any missing columns (same rule as ensureHeaders_, without re-reading the header row).
  const existingSet = {};
  liveHeaders.forEach(h => { if (h) existingSet[headerKey_(h)] = true; });
  const photoAliasOf = {};
  Object.keys(PHOTO_FIELD_ALIASES_).forEach(f => PHOTO_FIELD_ALIASES_[f].forEach(a => { photoAliasOf[a] = f; }));
  const hasAlias = h => Object.keys(existingSet).some(k => photoAliasOf[k] === h);
  const missing = expected.filter(h => !existingSet[headerKey_(h)] && !hasAlias(h));
  if (missing.length) {
    roundSheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    missing.forEach(h => liveHeaders.push(h));
  }

  // Who is already in this round (first column named Round_Name / Enrollment_No wins, as before).
  const rnIdx = liveHeaders.indexOf('Round_Name');
  const enIdx = liveHeaders.indexOf('Enrollment_No');
  const existingEnrollments = {};
  if (rnIdx !== -1 && enIdx !== -1) {
    data.slice(1).forEach(row => {
      if (normalizeStr_(row[rnIdx]) === normalizeStr_(roundName)) {
        existingEnrollments[normalizeEnrollmentNo_(row[enIdx])] = true;
      }
    });
  }

  const seenThisPull = {};
  const rowsToAdd = [];
  sourceRows.forEach(s => {
    const key = normalizeEnrollmentNo_(s.Enrollment_No);
    if (!key || existingEnrollments[key] || seenThisPull[key]) return;
    seenThisPull[key] = true;
    const dataObject = Object.assign({}, s, { Company_Name: companyName, Round_Name: roundName, Result: '' });
    rowsToAdd.push(liveHeaders.map(h => (dataObject[h] !== undefined ? dataObject[h] : '')));
  });
  if (rowsToAdd.length > 0) {
    roundSheet.getRange(lastRow + 1, 1, rowsToAdd.length, liveHeaders.length).setValues(rowsToAdd);
  }
  return rowsToAdd.length;
}

// ===================================================================
// ROLL CALL: SAVE SEVERAL STUDENTS IN ONE REQUEST
// Same rules and same messages as rollCallAssignStudent (which stays as it is), applied to each student in
// order. One access check, one read of the round tab, one lock, one write and one audit write for the whole
// batch, instead of all of that once per student. Returns { success:true, results:[ ...one per student ] }, where
// each entry looks exactly like what rollCallAssignStudent returns for that student.
// items: [{ enrollmentNo, groupNo, groupSize }]
// ===================================================================
function rollCallAssignStudentsBatch(companyName, roundName, items, adminToken, volunteerName, volunteerMobile) {
  try {
    if (!items || !items.length) return { success: true, results: [] };
    const blocked = assertVolunteerRoundAccess_(companyName, roundName, volunteerMobile);
    if (blocked) return blocked;
    const sheet = getExistingRoundSheetForCompany_(companyName);
    if (!sheet) return { success: false, message: 'No student list found for this round yet.' };

    const lock = LockService.getScriptLock();
    try { lock.waitLock(8000); } catch (e) {
      return { success: false, message: 'Server is busy right now — please try again in a moment.' };
    }
    try {
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const roundCol = headers.indexOf('Round_Name');
      const enrollCol = headers.indexOf('Enrollment_No');
      const groupCol = headers.indexOf('Group_No');
      const nameCol = headers.indexOf('Student_Name');
      const wantedRound = normalizeStr_(roundName);

      // this round's rows: last row per enrollment wins (as in the single version); live group per row; headcount per group
      const rowOfEnrollment = {};
      const groupAtRow = {};
      const counts = {};
      for (let i = 1; i < data.length; i++) {
        if (normalizeStr_(data[i][roundCol]) !== wantedRound) continue;
        rowOfEnrollment[normalizeEnrollmentNo_(data[i][enrollCol])] = i;
        const g = data[i][groupCol];
        groupAtRow[i] = g;
        if (g !== '' && g !== null && g !== undefined) counts[Number(g)] = (counts[Number(g)] || 0) + 1;
      }

      const results = [];
      const assigned = [];   // { row, group, enrollmentNo }
      items.forEach(item => {
        const size = Math.max(1, parseInt(item.groupSize, 10) || 20);
        const targetGroup = Math.max(1, parseInt(item.groupNo, 10) || 1);
        const rowIdx = rowOfEnrollment[normalizeEnrollmentNo_(item.enrollmentNo)];
        if (rowIdx === undefined) { results.push({ success: false, message: 'That enrollment number is not in this round\'s list.' }); return; }
        const existing = groupAtRow[rowIdx];
        if (existing !== '' && existing !== null && existing !== undefined) {
          results.push({ success: false, message: (data[rowIdx][nameCol] || 'This student') + ' is already in Group ' + existing + '.', alreadyGrouped: true, groupNo: Number(existing) });
          return;
        }
        const count = counts[targetGroup] || 0;
        if (count >= size) { results.push({ success: false, message: 'Group ' + targetGroup + ' just filled up.', groupFull: true, groupNo: targetGroup, count: count }); return; }
        groupAtRow[rowIdx] = targetGroup;
        counts[targetGroup] = count + 1;
        assigned.push({ row: rowIdx, group: targetGroup, enrollmentNo: item.enrollmentNo });
        results.push({
          success: true, studentName: data[rowIdx][nameCol] || '', enrollmentNo: data[rowIdx][enrollCol],
          groupNo: targetGroup, count: count + 1, groupFull: count + 1 >= size
        });
      });

      if (assigned.length) {
        const rows = assigned.map(a => a.row);
        const minRow = Math.min.apply(null, rows), maxRow = Math.max.apply(null, rows);
        const block = [];
        for (let r = minRow; r <= maxRow; r++) block.push([data[r][groupCol]]);   // untouched rows keep their value
        assigned.forEach(a => { block[a.row - minRow][0] = a.group; });
        sheet.getRange(minRow + 1, groupCol + 1, block.length, 1).setValues(block);

        // audit: one row per student, exactly like the single version, written in one go
        try {
          const admin = getAdminFromToken_(adminToken);
          const who = admin
            ? [admin.name, admin.email, 'Admin']
            : (volunteerMobile ? [volunteerName || 'Unknown Volunteer', normalizeMobileDigits_(volunteerMobile), 'Volunteer'] : ['Unknown', '', 'System']);
          const stamp = formatIstTimestamp_(new Date());
          const auditRows = assigned.map(a => [stamp, who[0] || 'Unknown', who[1] || '', who[2] || 'System', 'UPDATE', roundName,
            a.enrollmentNo || '', a.enrollmentNo + ' -> Group ' + a.group + ' (Roll Call)']);
          const audit = getAuditLogSheet_();
          audit.getRange(audit.getLastRow() + 1, 1, auditRows.length, auditRows[0].length).setValues(auditRows);
        } catch (auditErr) {
          Logger.log('batch audit failed: ' + auditErr.message);
        }
      }
      return { success: true, results: results };
    } catch (err) {
      return { success: false, message: err.message };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
