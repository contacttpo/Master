// Backend functions rewritten for the Sheets API. Each returns EXACTLY what the Apps Script
// version returns, so the pages need no change. Add more here one at a time; each new one is
// checked against the original at  /api/status?compare=1  before it is trusted.
const { getSheets, getOneSheet, getSheetTitles, toObjects } = require('./google');

// Same as normalizeStr_ in Code.gs
function normalizeStr(v) {
  let s = (v === null || v === undefined) ? '' : String(v).trim();
  if (s.length >= 2) {
    const f = s.charAt(0), l = s.charAt(s.length - 1);
    if ((f === '"' && l === '"') || (f === '\u201C' && l === '\u201D')) s = s.substring(1, s.length - 1).trim();
  }
  return s;
}

// Columns Apps Script guarantees on Companies_Master (getSheet_ adds missing ones as blank)
const COMPANIES_HEADERS = ['Company_Name', 'Status', 'Current_Stage', 'Date',
  'Eligible_Branches', 'Criteria', 'Package', 'POC_Name', 'POC_Email', 'POC_Contact',
  'JD_File_Name', 'JD_File_URL', 'Final_Summary', 'Final_Mail_Name', 'Final_Mail_URL',
  'Company_List_Name', 'Company_List_URL', 'Process_Photos_JSON', 'Logo_URL',
  'Initial_Mail_Name', 'Initial_Mail_URL', 'Team_Members_JSON'];

async function getDashboardData() {
  const s = await getSheets(['Companies_Master', 'Selected_Students']);
  const companies = toObjects(s.Companies_Master, { Date: true });
  const students = toObjects(s.Selected_Students);
  const counts = {};
  students.forEach(st => {
    const n = normalizeStr(st.Company_Name);
    counts[n] = (counts[n] || 0) + 1;
  });
  const data = companies.map(c => {
    COMPANIES_HEADERS.forEach(h => { if (!Object.prototype.hasOwnProperty.call(c, h)) c[h] = ''; });
    c.SelectedCount = counts[normalizeStr(c.Company_Name)] || 0;
    return c;
  });
  return { success: true, data: data };
}

async function getCompanyList() {
  const s = await getSheets(['Selected_Students']);
  const set = {};
  toObjects(s.Selected_Students).forEach(r => {
    const co = normalizeStr(r.Company_Name);
    if (co) set[co] = true;
  });
  return { success: true, data: Object.keys(set).sort() };
}

// ---------- shared helpers (same rules as Code.gs) ----------
function sanitizeForSheetName(name) {
  let s = normalizeStr(name).replace(/[\[\]\*\?\/\\:]/g, ' ').replace(/^'+/, '').replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = s.substring(0, 80).trim();
  return s || 'Unnamed';
}
const normEnroll = v => normalizeStr(v).toUpperCase();

const REGISTERED_STUDENTS_HEADERS = ['Company_Name', 'Enrollment_No', 'Student_Name',
  'Branch', 'College', 'Mobile_No', 'Email_ID', 'Attendance', 'Check_In_Time'];

const BRANCH_OPTIONS_BY_COURSE = {
  'Engineering': ['CSE', 'DS', 'IoT', 'AIML', 'AIR', 'CSBS', 'AI&DS', 'CSD', 'ECE', 'EE', 'EX', 'ME', 'CE'],
  'MCA': ['MCA'],
  'Management': ['MBA-Core', 'MBA-BA', 'MBA-FT'],
  'Non Engineering Graduation': ['BA', 'B.Com.', 'BBA', 'BCA', 'B.Sc.']
};

// Students_Master is big and rarely changes: keep it for 60 seconds.
let masterCache = { t: 0, rows: null, map: null };
async function getMaster() {
  if (masterCache.rows && Date.now() - masterCache.t < 60000) return masterCache;
  const rows = toObjects(await getOneSheet('Students_Master'), 'auto');
  const map = {};
  rows.forEach(r => { map[normEnroll(r.Enrollment)] = r; });
  masterCache = { t: Date.now(), rows: rows, map: map };
  return masterCache;
}

async function getBranchAndCollegeLists() {
  const master = await getMaster();
  const branchSet = {};
  Object.keys(BRANCH_OPTIONS_BY_COURSE).forEach(course => {
    BRANCH_OPTIONS_BY_COURSE[course].forEach(b => { branchSet[b] = true; });
  });
  const collegeSet = {};
  master.rows.forEach(r => {
    const b = normalizeStr(r.Branch); if (b) branchSet[b] = true;
    const c = normalizeStr(r.College); if (c) collegeSet[c] = true;
  });
  return { success: true, branches: Object.keys(branchSet).sort(), colleges: Object.keys(collegeSet).sort() };
}

async function getRegisteredStudents(companyName) {
  const [vals, master] = await Promise.all([getOneSheet('Reg__' + sanitizeForSheetName(companyName)), getMaster()]);
  const rows = toObjects(vals, 'auto');
  if (rows.length === 0) return { success: true, data: rows };
  rows.forEach(r => {
    REGISTERED_STUDENTS_HEADERS.forEach(h => { if (!Object.prototype.hasOwnProperty.call(r, h)) r[h] = ''; });
    const m = master.map[normEnroll(r.Enrollment_No)];
    const personal = normalizeStr(r.Personal_Email) || (m && normalizeStr(m.Personal_Email)) || '';
    r.Display_Email = personal || normalizeStr(r.Email_ID);
  });
  return { success: true, data: rows };
}

async function getRoundStudents(companyName, roundName) {
  const round = normalizeStr(roundName);
  const safe = sanitizeForSheetName(companyName);
  const [rndVals, regVals, master] = await Promise.all([
    getOneSheet('Rnd__' + safe), getOneSheet('Reg__' + safe), getMaster()]);
  const rows = toObjects(rndVals, 'auto').filter(r => normalizeStr(r.Round_Name) === round);
  if (rows.length) {
    const regMap = {};
    toObjects(regVals, 'auto').forEach(r => { regMap[normEnroll(r.Enrollment_No)] = r; });
    rows.forEach(r => {
      const key = normEnroll(r.Enrollment_No);
      const reg = regMap[key], m = master.map[key];
      const personal = normalizeStr(r.Personal_Email)
        || (reg && normalizeStr(reg.Personal_Email))
        || (m && normalizeStr(m.Personal_Email)) || '';
      r.Display_Email = personal || normalizeStr(r.Email_ID);
    });
  }
  return { success: true, data: rows };
}

// The live numbers on the Round Manager table (Appeared / Shortlisted / Rejected / Selected per round).
// Apps Script quietly "carries forward" shortlisted students (a write) when someone is missing from the
// next round. This read-only version detects that case and hands the request back to Apps Script.
async function getRoundCounts(companyName) {
  const name = normalizeStr(companyName);
  const [procVals, selVals, rndVals] = await Promise.all([
    getOneSheet('Process_Tracking'), getOneSheet('Selected_Students'), getOneSheet('Rnd__' + sanitizeForSheetName(companyName))]);
  const rounds = toObjects(procVals).filter(r => normalizeStr(r.Company_Name) === name);
  const roundRows = toObjects(rndVals, 'auto');
  const selectedRows = toObjects(selVals);

  // ---- same check as companyNeedsForward_ in Code.gs ----
  if (rounds.length && roundRows.length) {
    const byRound = {};
    roundRows.forEach(r => {
      const rn = normalizeStr(r.Round_Name);
      if (!byRound[rn]) byRound[rn] = { keys: {}, shortlisted: [] };
      const key = normEnroll(r.Enrollment_No);
      if (!key) return;
      byRound[rn].keys[key] = true;
      if (normalizeStr(r.Result) === 'Shortlisted') byRound[rn].shortlisted.push(key);
    });
    const selectedKeys = {};
    selectedRows.forEach(st => {
      if (normalizeStr(st.Company_Name) !== name) return;
      const k = normEnroll(st.Enrollment_No);
      if (k) selectedKeys[k] = true;
    });
    for (let i = 0; i < rounds.length; i++) {
      const info = byRound[normalizeStr(rounds[i].Round_Name)];
      if (!info || !info.shortlisted.length) continue;
      if (i === rounds.length - 1) {
        if (info.shortlisted.some(k => !selectedKeys[k])) throw new Error('needs carry-forward (handled by Apps Script)');
      } else {
        const next = byRound[normalizeStr(rounds[i + 1].Round_Name)];
        const nextKeys = next ? next.keys : {};
        if (info.shortlisted.some(k => !nextKeys[k])) throw new Error('needs carry-forward (handled by Apps Script)');
      }
    }
  }

  // ---- same counting as getCompanyCoreData_ ----
  const counts = {};
  roundRows.forEach(rs => {
    const rn = normalizeStr(rs.Round_Name);
    if (!rn) return;
    if (!counts[rn]) counts[rn] = { appeared: 0, shortlisted: 0, rejected: 0, selected: 0 };
    counts[rn].appeared++;
    const result = normalizeStr(rs.Result);
    if (result === 'Shortlisted') counts[rn].shortlisted++;
    else if (result === 'Rejected') counts[rn].rejected++;
    else if (result === 'Selected') counts[rn].selected++;
  });
  return {
    success: true,
    counts: rounds.map(r => {
      const c = counts[normalizeStr(r.Round_Name)] || { appeared: 0, shortlisted: 0, rejected: 0, selected: 0 };
      return { Round_Name: r.Round_Name, Students_Appeared: c.appeared, Students_Shortlisted: c.shortlisted,
               Students_Rejected: c.rejected, Students_Selected: c.selected };
    })
  };
}

// ---------- company details (the biggest screen) ----------
const ROUNDS_HEADERS = ['Company_Name', 'Round_Name', 'Students_Appeared', 'Students_Shortlisted', 'Remarks', 'Round_Status', 'Group_Mode', 'GD_Group_Size'];
const STUDENTS_HEADERS = ['S_No', 'Enrollment_No', 'Company_Name', 'Student_Name', 'Mobile_No',
  'Reference_ID', 'Branch', 'College', 'Category', 'Email_ID', 'Offer_Letter_Name', 'Offer_Letter_URL',
  'Package', 'Photo_Status', 'Photo_Requested_At', 'Photo_Submitted_At', 'Photo_File_Name', 'Photo_URL'];
const PHOTO_FIELDS = ['Photo_Status', 'Photo_Requested_At', 'Photo_Submitted_At', 'Photo_File_Name', 'Photo_URL'];
const PHOTO_FIELD_ALIASES = {
  Photo_Status:       ['photostatus', 'photosubmissionstatus', 'photosubmitstatus', 'photostate'],
  Photo_Requested_At: ['photorequestedat', 'photorequestedon', 'photorequesteddate', 'photorequesttime'],
  Photo_Submitted_At: ['photosubmittedat', 'photosubmittedon', 'photosubmitteddate', 'photosubmissiondate', 'photosubmittime'],
  Photo_File_Name:    ['photofilename', 'photofile', 'photoname'],
  Photo_URL:          ['photourl', 'photolink', 'photodriveurl', 'photodrivelink', 'photofileurl']
};
const headerKey = h => String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
const looseName = v => String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

// Apps Script adds any missing expected column to the sheet before reading (ensureHeaders_); do the same virtually.
function withExpected(headers, expected) {
  const existing = {};
  headers.forEach(h => { if (h) existing[headerKey(h)] = true; });
  const aliasOf = {};
  Object.keys(PHOTO_FIELD_ALIASES).forEach(f => PHOTO_FIELD_ALIASES[f].forEach(a => { aliasOf[a] = f; }));
  const hasAlias = h => Object.keys(existing).some(k => aliasOf[k] === h);
  const out = headers.slice();
  expected.forEach(h => { if (!existing[headerKey(h)] && !hasAlias(h)) out.push(h); });
  return out;
}

function detectStudentPhotoColumns(headers, rows) {
  const out = {};
  const nonEmpty = idx => { let n = 0; for (let i = 0; i < rows.length; i++) { const v = rows[i][idx]; if (v !== '' && v !== null && v !== undefined) n++; } return n; };
  Object.keys(PHOTO_FIELD_ALIASES).forEach(field => {
    const aliases = PHOTO_FIELD_ALIASES[field];
    let best = -1, bestCount = -1;
    headers.forEach((h, i) => {
      if (aliases.indexOf(headerKey(h)) === -1) return;
      const c = nonEmpty(i);
      if (c > bestCount) { best = i; bestCount = c; }
    });
    out[field] = best;
  });
  const used = {}; Object.keys(out).forEach(f => { if (out[f] > -1) used[out[f]] = true; });
  if (out.Photo_URL === -1 || out.Photo_Status === -1) {
    headers.forEach((h, i) => {
      if (used[i]) return;
      const k = headerKey(h);
      if (k.indexOf('offer') !== -1) return;
      let drive = 0, submitted = 0, filled = 0;
      rows.forEach(r => {
        const v = String(r[i] === null || r[i] === undefined ? '' : r[i]);
        if (!v) return; filled++;
        if (/drive\.google\.com|docs\.google\.com/i.test(v)) drive++;
        if (/^\s*submitted\s*$/i.test(v)) submitted++;
      });
      if (out.Photo_URL === -1 && k.indexOf('photo') !== -1 && filled && drive / filled > 0.6) { out.Photo_URL = i; used[i] = true; }
      else if (out.Photo_Status === -1 && k.indexOf('photo') !== -1 && submitted > 0) { out.Photo_Status = i; used[i] = true; }
    });
  }
  return out;
}

function canonicalizeStudentHeaders(headers, rows) {
  const map = detectStudentPhotoColumns(headers, rows);
  const h2 = headers.slice();
  const chosen = {};
  Object.keys(map).forEach(f => { if (map[f] > -1) chosen[map[f]] = f; });
  headers.forEach((h, i) => {
    if (chosen[i]) h2[i] = chosen[i];
    else if (Object.keys(PHOTO_FIELD_ALIASES).some(f => PHOTO_FIELD_ALIASES[f].indexOf(headerKey(h)) !== -1 || headerKey(h) === headerKey(f))) h2[i] = h + '__unused';
  });
  return h2;
}

function fixStudentPhotoStatus(obj) {
  const val = v => String(v === undefined || v === null ? '' : v).trim();
  const st = val(obj.Photo_Status).toLowerCase();
  const hasEvidence = !!(val(obj.Photo_URL) || val(obj.Photo_File_Name) || val(obj.Photo_Submitted_At));
  if (st === 'submitted' || st === 'received' || st === 'done' || hasEvidence) obj.Photo_Status = 'Submitted';
  else if (st === 'requested' || st === 'pending') obj.Photo_Status = 'Requested';
  return obj;
}

function photoRank(r) {
  if (normalizeStr(r.Photo_URL) || normalizeStr(r.Photo_File_Name) || normalizeStr(r.Photo_Submitted_At)) return 3;
  if (r.Photo_Status === 'Submitted') return 2;
  if (r.Photo_Status === 'Requested') return 1;
  return 0;
}

// Selected_Students rows exactly as sheetToObjects_ returns them for that tab.
function selectedStudentObjects(values) {
  if (!values || values.length < 2) return [];
  const rows = values.slice(1);
  const base = withExpected(values[0], STUDENTS_HEADERS);
  const headers = canonicalizeStudentHeaders(base, rows);
  return toObjects(values, 'auto', headers).map(fixStudentPhotoStatus);
}

// Same check as companyNeedsForward_: true when Apps Script would WRITE (carry shortlisted students forward).
function needsForward(rounds, roundRows, selectedRows, name) {
  if (!rounds.length || !roundRows.length) return false;
  const byRound = {};
  roundRows.forEach(r => {
    const rn = normalizeStr(r.Round_Name);
    if (!byRound[rn]) byRound[rn] = { keys: {}, shortlisted: [] };
    const key = normEnroll(r.Enrollment_No);
    if (!key) return;
    byRound[rn].keys[key] = true;
    if (normalizeStr(r.Result) === 'Shortlisted') byRound[rn].shortlisted.push(key);
  });
  const selectedKeys = {};
  selectedRows.forEach(st => {
    if (normalizeStr(st.Company_Name) !== name) return;
    const k = normEnroll(st.Enrollment_No);
    if (k) selectedKeys[k] = true;
  });
  for (let i = 0; i < rounds.length; i++) {
    const info = byRound[normalizeStr(rounds[i].Round_Name)];
    if (!info || !info.shortlisted.length) continue;
    if (i === rounds.length - 1) {
      if (info.shortlisted.some(k => !selectedKeys[k])) return true;
    } else {
      const next = byRound[normalizeStr(rounds[i + 1].Round_Name)];
      const nextKeys = next ? next.keys : {};
      if (info.shortlisted.some(k => !nextKeys[k])) return true;
    }
  }
  return false;
}

// First Reg__ tab (left to right) that has a mobile number for a student wins -- same as Code.gs.
async function mobilesFromAllRegistrations(neededKeys) {
  const map = {};
  const needed = {};
  let remaining = 0;
  neededKeys.forEach(k => { if (k && !needed[k]) { needed[k] = true; remaining++; } });
  if (!remaining) return map;
  const titles = (await getSheetTitles()).filter(t => t.indexOf('Reg__') === 0);
  for (let i = 0; i < titles.length && remaining > 0; i += 4) {
    const chunk = titles.slice(i, i + 4);
    const data = await getSheets(chunk);
    for (const t of chunk) {
      if (remaining <= 0) break;
      const rows = toObjects(data[t], 'auto');
      for (let j = 0; j < rows.length && remaining > 0; j++) {
        const key = normEnroll(rows[j].Enrollment_No);
        if (!key || !needed[key] || map[key]) continue;
        const mobile = normalizeStr(rows[j].Mobile_No);
        if (mobile) { map[key] = mobile; remaining--; }
      }
    }
  }
  return map;
}

async function getCompanyDetails(companyName) {
  const name = normalizeStr(companyName);
  const safe = sanitizeForSheetName(companyName);
  const [compVals, procVals, selVals, rndVals, regVals, master] = await Promise.all([
    getOneSheet('Companies_Master'), getOneSheet('Process_Tracking'), getOneSheet('Selected_Students'),
    getOneSheet('Rnd__' + safe), getOneSheet('Reg__' + safe), getMaster()]);

  const companies = compVals.length > 1 ? toObjects(compVals, { Date: true }, withExpected(compVals[0], COMPANIES_HEADERS)) : [];
  const company = companies.find(c => normalizeStr(c.Company_Name) === name) || null;
  if (company) {
    let photos = [];
    try { const parsed = JSON.parse(company.Process_Photos_JSON); photos = Array.isArray(parsed) ? parsed : []; } catch (e) { photos = []; }
    company.Process_Photos = company.Process_Photos_JSON ? photos : [];
  }
  const rounds = (procVals.length > 1 ? toObjects(procVals, null, withExpected(procVals[0], ROUNDS_HEADERS)) : [])
    .filter(r => normalizeStr(r.Company_Name) === name);

  const allSelected = selectedStudentObjects(selVals);
  const roundRows = toObjects(rndVals, 'auto');
  if (needsForward(rounds, roundRows, allSelected, name)) throw new Error('needs carry-forward (handled by Apps Script)');

  const rawStudents = allSelected.filter(st => normalizeStr(st.Company_Name) === name);

  // per-round counts + students who advanced at least once
  const tally = {}, everShortlisted = {};
  roundRows.forEach(rs => {
    const rn = normalizeStr(rs.Round_Name);
    if (!rn) return;
    if (!tally[rn]) tally[rn] = { appeared: 0, shortlisted: 0, rejected: 0, selected: 0 };
    tally[rn].appeared++;
    const result = normalizeStr(rs.Result);
    if (result === 'Shortlisted') tally[rn].shortlisted++;
    else if (result === 'Rejected') tally[rn].rejected++;
    else if (result === 'Selected') tally[rn].selected++;
    if (result === 'Shortlisted' || result === 'Selected') {
      const key = normEnroll(rs.Enrollment_No);
      if (key) everShortlisted[key] = true;
    }
  });
  rounds.forEach(r => {
    const c = tally[normalizeStr(r.Round_Name)] || { appeared: 0, shortlisted: 0, rejected: 0, selected: 0 };
    r.Students_Appeared = c.appeared; r.Students_Shortlisted = c.shortlisted;
    r.Students_Rejected = c.rejected; r.Students_Selected = c.selected;
  });

  const registeredKeys = {}, appearedKeys = {};
  toObjects(regVals, 'auto').forEach(r => {
    const key = normEnroll(r.Enrollment_No);
    if (!key) return;
    registeredKeys[key] = true;
    if (normalizeStr(r.Attendance) === 'Present') appearedKeys[key] = true;
  });
  const selectedKeys = {};
  rawStudents.forEach(st => { const key = normEnroll(st.Enrollment_No); if (key) selectedKeys[key] = true; });
  const funnel = {
    registered: Object.keys(registeredKeys).length, appeared: Object.keys(appearedKeys).length,
    shortlisted: Object.keys(everShortlisted).length, selected: Object.keys(selectedKeys).length
  };

  // photo columns: if another row for the same student has a better photo record, use it (overlayPhotoDataFromSheet_)
  if (rawStudents.length) {
    const wanted = looseName(companyName);
    const best = {};
    allSelected.map(r => Object.assign({}, r)).forEach(r => {
      if (looseName(r.Company_Name) !== wanted) return;
      const k = looseName(r.Enrollment_No);
      if (!k) return;
      if (!best[k] || photoRank(r) > photoRank(best[k])) best[k] = r;
    });
    rawStudents.forEach(row => {
      const donor = best[looseName(row.Enrollment_No)];
      if (!donor || photoRank(donor) <= photoRank(row)) return;
      PHOTO_FIELDS.forEach(f => { row[f] = donor[f]; });
    });
  }

  // join each selected student with their Students_Master record; backfill missing mobile numbers
  const needMobile = [];
  rawStudents.forEach(st => {
    const m = master.map[normEnroll(st.Enrollment_No)] || null;
    if (!(normalizeStr(st.Mobile_No) || normalizeStr(m && m.Student_Mob))) needMobile.push(normEnroll(st.Enrollment_No));
  });
  const mobileMap = await mobilesFromAllRegistrations(needMobile);
  const students = rawStudents.map(st => {
    const m = master.map[normEnroll(st.Enrollment_No)] || null;
    const merged = Object.assign({}, m || {}, st);
    if (!normalizeStr(merged.Mobile_No)) {
      merged.Mobile_No = mobileMap[normEnroll(st.Enrollment_No)] || normalizeStr(m && m.Student_Mob) || '';
    }
    return merged;
  });
  return { success: true, company: company, rounds: rounds, students: students, funnel: funnel };
}

module.exports = { getDashboardData, getCompanyList, getBranchAndCollegeLists, getRegisteredStudents, getRoundStudents, getRoundCounts, getCompanyDetails };
