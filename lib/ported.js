// Backend functions rewritten for the Sheets API. Each returns EXACTLY what the Apps Script
// version returns, so the pages need no change. Add more here one at a time; each new one is
// checked against the original at  /api/status?compare=1  before it is trusted.
const googleLib = require('./google');
const { getSheets, getOneSheet, getSheetOrNull, getSheetTitles, toObjects } = googleLib;
// Loaded only when the registration form functions run, so a missing lib/regconst.js can only affect those two.
let regcModule = null;
const REGC = new Proxy({}, { get: (_, key) => { if (!regcModule) regcModule = require('./regconst'); return regcModule[key]; } });
const nodeCrypto = require('crypto');

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

const STUDENTS_MASTER_HEADERS = [
  'College', 'Enrollment', 'Name', 'Aadhar', 'DOB', 'Gender', 'Category',
  'Father_Name', 'Mother_Name', 'Student_Mob', 'Parent_Mob', 'Personal_Email', 'College_Email',
  'Medium', '10th_Board', '10th_YOP', '10th_Percent', 'Qualification_Type', '12th_Board', '12th_YOP', '12th_Percent',
  'School_Name', 'Location', 'City', 'Branch', 'MCA_Grad_Stream', 'MCA_Grad_Other',
  'S1', 'S2', 'S3', 'S4', 'S5', 'BTech_CGPA', 'Grad_Marks', 'MCA_S1', 'MCA_S2',
  'Total_Backs', 'Active_Backs', 'Batch'
];

const REGISTERED_STUDENTS_HEADERS = ['Company_Name', 'Enrollment_No', 'Student_Name',
  'Branch', 'College', 'Mobile_No', 'Email_ID', 'Attendance', 'Check_In_Time'];

const BRANCH_OPTIONS_BY_COURSE = {
  'Engineering': ['CSE', 'DS', 'IoT', 'AIML', 'AIR', 'CSBS', 'AI&DS', 'CSD', 'ECE', 'EE', 'EX', 'ME', 'CE'],
  'Pharmacy': ['B.Pharma'],
  'MCA': ['MCA'],
  'Management': ['MBA-Core', 'MBA-BA', 'MBA-FT'],
  'Non Engineering Graduation': ['BA', 'B.Com.', 'BBA', 'BCA', 'B.Sc.']
};
// Option lists the registration form shows. Kept here (not read from lib/regconst.js) so adding a
// course/college is a one-file change on Vercel. Keep in sync with Code.gs.
const FORM_COURSE_OPTIONS = ['Engineering', 'Pharmacy', 'MCA', 'Management', 'Non Engineering Graduation'];
const FORM_COLLEGE_OPTIONS = ['GGITS', 'GGCT', 'GGCE'];

// Students_Master is big and rarely changes: keep it for 60 seconds.
let masterCache = { t: 0, rows: null, map: null };
async function getMaster() {
  if (masterCache.rows && Date.now() - masterCache.t < 60000) return masterCache;
  const vals = await getOneSheet('Students_Master');
  const rows = vals.length > 1 ? toObjects(vals, 'auto', withExpected(vals[0], STUDENTS_MASTER_HEADERS)) : [];
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
    if (!counts[rn]) counts[rn] = { appeared: 0, shortlisted: 0, rejected: 0, selected: 0, absent: 0 };
    const result = normalizeStr(rs.Result);
    // Absent students are in the round's list but did not appear, so they are counted separately.
    if (result === 'Absent') { counts[rn].absent++; return; }
    counts[rn].appeared++;
    if (result === 'Shortlisted') counts[rn].shortlisted++;
    else if (result === 'Rejected') counts[rn].rejected++;
    else if (result === 'Selected') counts[rn].selected++;
  });
  return {
    success: true,
    counts: rounds.map(r => {
      const c = counts[normalizeStr(r.Round_Name)] || { appeared: 0, shortlisted: 0, rejected: 0, selected: 0, absent: 0 };
      return { Round_Name: r.Round_Name, Students_Appeared: c.appeared, Students_Shortlisted: c.shortlisted,
               Students_Rejected: c.rejected, Students_Selected: c.selected, Students_Absent: c.absent };
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
    if (!tally[rn]) tally[rn] = { appeared: 0, shortlisted: 0, rejected: 0, selected: 0, absent: 0 };
    const result = normalizeStr(rs.Result);
    if (result === 'Absent') { tally[rn].absent++; return; }
    tally[rn].appeared++;
    if (result === 'Shortlisted') tally[rn].shortlisted++;
    else if (result === 'Rejected') tally[rn].rejected++;
    else if (result === 'Selected') tally[rn].selected++;
    if (result === 'Shortlisted' || result === 'Selected') {
      const key = normEnroll(rs.Enrollment_No);
      if (key) everShortlisted[key] = true;
    }
  });
  rounds.forEach(r => {
    const c = tally[normalizeStr(r.Round_Name)] || { appeared: 0, shortlisted: 0, rejected: 0, selected: 0, absent: 0 };
    r.Students_Appeared = c.appeared; r.Students_Shortlisted = c.shortlisted;
    r.Students_Rejected = c.rejected; r.Students_Selected = c.selected; r.Students_Absent = c.absent;
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

// ---------- Home / Branches analytics (read-only summaries) ----------
function parsePackageNumber(pkg) {
  const s = normalizeStr(pkg).replace(/,/g, '');
  if (!s) return 0;
  const match = s.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}
function median(sortedNums) {
  const n = sortedNums.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}
function dedupeByEnrollment(rows, field) {
  const seen = {};
  return rows.filter(r => {
    const key = normEnroll(r[field]);
    if (!key) return true;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}
async function getSelected() { return selectedStudentObjects(await getOneSheet('Selected_Students')); }

async function getBranchViewFilters() {
  const bc = await getBranchAndCollegeLists();
  const companies = await getCompanyList();
  return { success: true, branches: bc.branches, colleges: bc.colleges, companies: companies.data };
}

async function getTopPackageStudents(limit) {
  const n = limit || 8;
  const all = await getSelected();
  const data = all
    .map(s => ({ Student_Name: s.Student_Name, Branch: s.Branch, Company_Name: s.Company_Name, Package: s.Package, _num: parsePackageNumber(s.Package) }))
    .filter(s => s._num > 0)
    .sort((a, b) => b._num - a._num)
    .slice(0, n)
    .map(s => ({ Student_Name: s.Student_Name, Branch: s.Branch, Company_Name: s.Company_Name, Package: s.Package }));
  return { success: true, data: data };
}

async function getPlacementRate() {
  const [master, selected] = await Promise.all([getMaster(), getSelected()]);
  const masterRows = dedupeByEnrollment(master.rows, 'Enrollment');
  const branchOf = {}, rosterByBranch = {};
  masterRows.forEach(r => {
    const branch = normalizeStr(r.Branch) || 'Unspecified';
    const key = normEnroll(r.Enrollment);
    if (key) branchOf[key] = branch;
    rosterByBranch[branch] = (rosterByBranch[branch] || 0) + 1;
  });
  const offersByBranch = {};
  let totalOffers = 0;
  selected.forEach(s => {
    const key = normEnroll(s.Enrollment_No);
    const branch = (key && branchOf[key]) || normalizeStr(s.Branch) || 'Unspecified';
    offersByBranch[branch] = (offersByBranch[branch] || 0) + 1;
    totalOffers++;
  });
  const pct = (sel, roster) => roster > 0 ? Math.round((sel / roster) * 1000) / 10 : 0;
  const overall = { registered: masterRows.length, selected: totalOffers, percent: pct(totalOffers, masterRows.length) };
  const names = {};
  Object.keys(rosterByBranch).forEach(b => { names[b] = true; });
  Object.keys(offersByBranch).forEach(b => { names[b] = true; });
  const byBranch = Object.keys(names).map(branch => {
    const roster = rosterByBranch[branch] || 0, offers = offersByBranch[branch] || 0;
    return { branch: branch, registered: roster, selected: offers, percent: pct(offers, roster) };
  }).sort((a, b) => b.selected - a.selected);
  return { success: true, overall: overall, byBranch: byBranch };
}

async function getPackageAnalytics() {
  const all = await getSelected();
  const withPackage = all
    .map(s => ({ Branch: normalizeStr(s.Branch) || 'Unspecified', Company_Name: s.Company_Name, _num: parsePackageNumber(s.Package) }))
    .filter(s => s._num > 0);
  function summarize(nums) {
    const sorted = nums.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      avg: sorted.length ? Math.round((sum / sorted.length) * 100) / 100 : 0,
      median: Math.round(median(sorted) * 100) / 100,
      min: sorted.length ? sorted[0] : 0,
      max: sorted.length ? sorted[sorted.length - 1] : 0
    };
  }
  const overall = summarize(withPackage.map(s => s._num));
  const byBranchMap = {};
  withPackage.forEach(s => { (byBranchMap[s.Branch] = byBranchMap[s.Branch] || []).push(s._num); });
  const byBranch = Object.keys(byBranchMap).map(b => Object.assign({ branch: b }, summarize(byBranchMap[b]))).sort((a, b) => b.avg - a.avg);
  const byCompanyMap = {};
  withPackage.forEach(s => {
    const key = normalizeStr(s.Company_Name) || 'Unspecified';
    (byCompanyMap[key] = byCompanyMap[key] || { name: s.Company_Name, nums: [] }).nums.push(s._num);
  });
  const byCompany = Object.keys(byCompanyMap).map(k => Object.assign({ company: byCompanyMap[k].name }, summarize(byCompanyMap[k].nums))).sort((a, b) => b.avg - a.avg);
  return { success: true, overall: overall, byBranch: byBranch, byCompany: byCompany };
}

async function getGlobalSelectionSummary() {
  const all = await getSelected();
  const total = all.length;
  const counts = {};
  all.forEach(s => { const b = normalizeStr(s.Branch) || 'Unspecified'; counts[b] = (counts[b] || 0) + 1; });
  const branchSummary = Object.keys(counts).map(b => ({
    branch: b, count: counts[b], percent: total > 0 ? Math.round((counts[b] / total) * 100) : 0
  })).sort((a, b) => b.count - a.count);
  return { success: true, total: total, branchSummary: branchSummary };
}

async function getAllStudentsMaster() {
  const [master, selected] = await Promise.all([getMaster(), getSelected()]);
  const index = {};
  selected.forEach(s => {
    const key = normEnroll(s.Enrollment_No);
    if (!key) return;
    if (!index[key]) index[key] = { count: 0, companies: [] };
    index[key].count += 1;
    index[key].companies.push(normalizeStr(s.Company_Name));
  });
  const rows = dedupeByEnrollment(master.rows.map(r => Object.assign({}, r)), 'Enrollment');
  const data = rows.map(r => {
    const sel = index[normEnroll(r.Enrollment)] || { count: 0, companies: [] };
    r.Total_Offers = sel.count;
    r.Companies_Selected = sel.companies.join(', ');
    r.Placement_Status = sel.count === 0 ? 'Not Placed' : (sel.count === 1 ? 'Placed' : 'Placed (Multiple Offers)');
    return r;
  });
  return { success: true, data: data };
}

// ---------- registration-form fields (Students window: Download picker + Add/Edit form) ----------
const REGISTRATION_FORM_FIELD_DEFS = [
 {
  "key": "Course",
  "label": "Course",
  "column": "Course"
 },
 {
  "key": "Name",
  "label": "Name",
  "column": "Student_Name"
 },
 {
  "key": "Branch",
  "label": "Branch",
  "column": "Branch"
 },
 {
  "key": "College",
  "label": "College",
  "column": "College"
 },
 {
  "key": "Student_Mob",
  "label": "Student Mobile",
  "column": "Mobile_No"
 },
 {
  "key": "College_Email",
  "label": "College Email",
  "column": "Email_ID"
 },
 {
  "key": "Aadhar",
  "label": "Aadhar Number",
  "column": "Aadhar"
 },
 {
  "key": "DOB",
  "label": "Date of Birth",
  "column": "DOB"
 },
 {
  "key": "Gender",
  "label": "Gender",
  "column": "Gender"
 },
 {
  "key": "Category",
  "label": "Category",
  "column": "Category"
 },
 {
  "key": "Father_Name",
  "label": "Father's Name",
  "column": "Father_Name"
 },
 {
  "key": "Mother_Name",
  "label": "Mother's Name",
  "column": "Mother_Name"
 },
 {
  "key": "Parent_Mob",
  "label": "Parent Mobile",
  "column": "Parent_Mob"
 },
 {
  "key": "Personal_Email",
  "label": "Personal Email",
  "column": "Personal_Email"
 },
 {
  "key": "Medium",
  "label": "Medium",
  "column": "Medium"
 },
 {
  "key": "10th_Board",
  "label": "10th Board",
  "column": "10th_Board"
 },
 {
  "key": "10th_YOP",
  "label": "10th Year of Passing",
  "column": "10th_YOP"
 },
 {
  "key": "10th_Percent",
  "label": "10th %",
  "column": "10th_Percent"
 },
 {
  "key": "10th_Marks_Obtained",
  "label": "Marks Obtained in 10th",
  "column": "10th_Marks_Obtained"
 },
 {
  "key": "10th_Total_Marks",
  "label": "Out of Total Marks of 10th",
  "column": "10th_Total_Marks"
 },
 {
  "key": "Qualification_Type",
  "label": "Qualification Type",
  "column": "Qualification_Type"
 },
 {
  "key": "12th_Board",
  "label": "12th Board",
  "column": "12th_Board"
 },
 {
  "key": "12th_YOP",
  "label": "12th Year of Passing",
  "column": "12th_YOP"
 },
 {
  "key": "12th_Percent",
  "label": "12th %",
  "column": "12th_Percent"
 },
 {
  "key": "12th_Marks_Obtained",
  "label": "Marks Obtained in 12th",
  "column": "12th_Marks_Obtained"
 },
 {
  "key": "12th_Total_Marks",
  "label": "Out of Total Marks of 12th",
  "column": "12th_Total_Marks"
 },
 {
  "key": "School_Name",
  "label": "School Name",
  "column": "School_Name"
 },
 {
  "key": "Location",
  "label": "Location",
  "column": "Location"
 },
 {
  "key": "City",
  "label": "City",
  "column": "City"
 },
 {
  "key": "Gap_In_Education",
  "label": "Gap in Education (Years)",
  "column": "Gap_In_Education"
 },
 {
  "key": "MCA_Grad_Stream",
  "label": "Graduation Degree",
  "column": "MCA_Grad_Stream"
 },
 {
  "key": "S1",
  "label": "Semester 1 %",
  "column": "S1"
 },
 {
  "key": "S2",
  "label": "Semester 2 %",
  "column": "S2"
 },
 {
  "key": "S3",
  "label": "Semester 3 %",
  "column": "S3"
 },
 {
  "key": "S4",
  "label": "Semester 4 %",
  "column": "S4"
 },
 {
  "key": "S5",
  "label": "Semester 5 %",
  "column": "S5"
 },
 {
  "key": "BTech_CGPA",
  "label": "B.Tech CGPA",
  "column": "BTech_CGPA"
 },
 {
  "key": "Grad_Marks",
  "label": "Graduation %",
  "column": "Grad_Marks"
 },
 {
  "key": "MCA_S1",
  "label": "MCA Semester 1 %",
  "column": "MCA_S1"
 },
 {
  "key": "MCA_S2",
  "label": "MCA Semester 2 %",
  "column": "MCA_S2"
 },
 {
  "key": "MCA_MBA_Percent",
  "label": "MCA/MBA % (Till Current Semester)",
  "column": "MCA_MBA_Percent"
 },
 {
  "key": "Total_Backs",
  "label": "Total Backlogs",
  "column": "Total_Backs"
 },
 {
  "key": "Active_Backs",
  "label": "Active Backlogs",
  "column": "Active_Backs"
 }
];
const REG_IDENTITY_KEYS = ['Name', 'Branch', 'College', 'Student_Mob', 'College_Email'];
const CUSTOM_Q_KEYS = ['Custom_Q1', 'Custom_Q2', 'Custom_Q3'];
const CUSTOM_Q_TYPES = ['text', 'yes_no', 'dropdown', 'radio', 'checkbox'];
const REG_FORM_CONFIG_HEADERS = ['Company_Name', 'Fields_JSON', 'Include_CV', 'Criteria_JSON', 'Company_Description',
  'Placed_Allowed', 'Excluded_Companies', 'Closes_At', 'Custom_Questions_JSON', 'Eligible_Courses_JSON'];

// Company names in the config tab are matched ignoring case, extra spaces and quotes, so a link built from a
// slightly different spelling of the name still finds its row.
const normCompanyKey = v => normalizeStr(v).replace(/\s+/g, ' ').toUpperCase();
function findCompanyRow(rows, companyIndex, companyName) {
  if (!Array.isArray(rows) || companyIndex < 0) return null;
  const strictWant = normCompanyKey(companyName);
  let row = rows.find(r => normCompanyKey(r[companyIndex]) === strictWant) || null;
  if (row) return row;
  const looseWant = looseName(companyName);
  if (!looseWant) return null;
  return rows.find(r => looseName(r[companyIndex]) === looseWant) || null;
}
// Build the config object by the tab's OWN header names (falls back to the expected position when a header is missing),
// so a re-ordered or extended Registration_Form_Config tab can never shift values into the wrong field.
function regConfigObject(headerRow, row) {
  const obj = {}; 
  REG_FORM_CONFIG_HEADERS.forEach((h, i) => {
    const idx = headerRow.indexOf(h);
    obj[h] = row[idx !== -1 ? idx : i];
  });
  return obj;
}
const humanizeColumnName = n => String(n || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function normalizeCustomQuestions(raw) {
  return CUSTOM_Q_KEYS.map((k, i) => {
    const q = (raw && raw[i]) || {};
    return {
      enabled: !!q.enabled,
      label: normalizeStr(q.label) || '',
      type: CUSTOM_Q_TYPES.indexOf(q.type) !== -1 ? q.type : 'text',
      required: !!q.required,
      options: Array.isArray(q.options) ? q.options.map(o => normalizeStr(o)).filter(Boolean) : []
    };
  });
}

// The parts of getRegistrationFormConfig the field lists need.
function readRegFormConfig(cfgVals, companyName) {
  const notFound = { found: false, fields: [], includeCV: false, customQuestions: normalizeCustomQuestions([]) };
  if (!cfgVals || cfgVals.length < 2) return notFound;
  const ci = cfgVals[0].indexOf('Company_Name');
  if (ci === -1) return notFound;
  const row = findCompanyRow(cfgVals.slice(1), ci, companyName);
  if (!row) return notFound;
  const obj = regConfigObject(cfgVals[0], row);
  let fields = [];
  try { fields = JSON.parse(obj.Fields_JSON || '[]'); } catch (e) { fields = []; }
  let raw = [];
  try { raw = JSON.parse(obj.Custom_Questions_JSON || '[]'); } catch (e) { raw = []; }
  return {
    found: true, fields: fields,
    includeCV: obj.Include_CV === true || obj.Include_CV === 'TRUE' || obj.Include_CV === 'true',
    customQuestions: normalizeCustomQuestions(raw)
  };
}

async function getRegisteredStudentDownloadFields(companyName) {
  const baseFields = [
    { key: 'Enrollment_No', label: 'Enrollment No.' }, { key: 'Student_Name', label: 'Name' },
    { key: 'Branch', label: 'Branch' }, { key: 'College', label: 'College' },
    { key: 'Mobile_No', label: 'Mobile No.' }, { key: 'Display_Email', label: 'Email ID' },
    { key: 'Attendance', label: 'Attendance' }, { key: 'Check_In_Time', label: 'Check-In Time' }
  ];
  const seen = {};
  baseFields.forEach(f => { seen[f.key] = true; });
  seen['Email_ID'] = true;
  const extra = [];
  const [cfgVals, regVals] = await Promise.all([
    normalizeStr(companyName) ? getOneSheet('Registration_Form_Config') : Promise.resolve([]),
    getOneSheet('Reg__' + sanitizeForSheetName(companyName))]);

  const cfg = readRegFormConfig(cfgVals, companyName);
  if (cfg.found) {
    const defByKey = {};
    REGISTRATION_FORM_FIELD_DEFS.forEach(f => { defByKey[f.key] = f; });
    (cfg.fields || []).forEach(k => {
      const def = defByKey[k];
      if (!def) return;
      if (REG_IDENTITY_KEYS.indexOf(k) !== -1) return;
      if (seen[def.column]) return;
      extra.push({ key: def.column, label: def.label });
      seen[def.column] = true;
    });
    if (cfg.includeCV) {
      extra.push({ key: 'CV_File_Name', label: 'CV File Name' });
      extra.push({ key: 'CV_File_URL', label: 'CV File Link' });
      seen['CV_File_Name'] = true; seen['CV_File_URL'] = true;
    }
    cfg.customQuestions.forEach((q, i) => {
      if (!q.enabled) return;
      const key = CUSTOM_Q_KEYS[i];
      if (seen[key]) return;
      extra.push({ key: key, label: q.label });
      seen[key] = true;
    });
  }
  if (regVals.length) {
    // the live header row, plus any standard columns Apps Script would have added to it first
    withExpected(regVals[0], REGISTERED_STUDENTS_HEADERS).forEach(h => {
      const header = String(h || '').trim();
      if (!header || seen[header]) return;
      seen[header] = true;
      extra.push({ key: header, label: humanizeColumnName(header) });
    });
  }
  return { success: true, fields: baseFields.concat(extra) };
}

// Fields shown in the Add/Edit student form: the form's own extra fields, without the standard columns,
// attendance, or CV links.
async function getRegisteredStudentEditFields(companyName) {
  const res = await getRegisteredStudentDownloadFields(companyName);
  const skip = { Display_Email: true, CV_File_Name: true, CV_File_URL: true };
  REGISTERED_STUDENTS_HEADERS.forEach(h => { skip[h] = true; });
  return { success: true, fields: (res.fields || []).filter(f => !skip[f.key]) };
}

// ---------- volunteer portal reads ----------
const ROUND_VOLUNTEERS_HEADERS = ['Company_Name', 'Round_Name', 'Round_Type', 'GD_Group_Size', 'Volunteer_Mobile',
  'Volunteer_Name', 'Assigned_Groups', 'Role', 'Access_Status'];
const digitsOnly = v => normalizeStr(v).replace(/\D/g, '');
function normalizeMobileDigits(v) { const d = digitsOnly(v); return d.length > 10 ? d.slice(-10) : d; }
function normalizeAccessStatus(v) { const s = normalizeStr(v); return (s === 'Paused' || s === 'Stopped') ? s : 'Active'; }

async function getGDRollCallCounts(companyName, roundName) {
  const data = await getSheetOrNull('Rnd__' + sanitizeForSheetName(companyName));
  if (data === null) return { success: false, message: 'No student list found for this round yet.' };
  const headers = data.length ? data[0] : [];
  const roundCol = headers.indexOf('Round_Name');
  const groupCol = headers.indexOf('Group_No');
  const counts = {};
  for (let i = 1; i < data.length; i++) {
    const rn = roundCol === -1 ? undefined : data[i][roundCol];
    if (normalizeStr(rn) !== normalizeStr(roundName)) continue;
    const g = groupCol === -1 ? undefined : data[i][groupCol];
    if (g === '' || g === null || g === undefined) continue;
    const n = Number(g);
    if (!isNaN(n)) counts[n] = (counts[n] || 0) + 1;
  }
  return { success: true, counts: counts };
}

async function getGDRollCallState(companyName, roundName) {
  const [rndVals, procVals] = await Promise.all([getSheetOrNull('Rnd__' + sanitizeForSheetName(companyName)), getOneSheet('Process_Tracking')]);
  if (rndVals === null) return { success: false, message: 'No student list found for this round yet.' };
  const rows = toObjects(rndVals, 'auto').filter(r => normalizeStr(r.Round_Name) === normalizeStr(roundName));
  const rounds = procVals.length > 1 ? toObjects(procVals, null, withExpected(procVals[0], ROUNDS_HEADERS)) : [];
  const roundRow = rounds.find(r => normalizeStr(r.Company_Name) === normalizeStr(companyName) && normalizeStr(r.Round_Name) === normalizeStr(roundName));
  let groupSize = parseInt(roundRow && roundRow.GD_Group_Size, 10);
  if (!groupSize) {
    const volVals = await getOneSheet('Round_Volunteers');
    const vols = volVals.length > 1 ? toObjects(volVals, 'auto', withExpected(volVals[0], ROUND_VOLUNTEERS_HEADERS)) : [];
    const a = vols.find(v => normalizeStr(v.Company_Name) === normalizeStr(companyName) &&
      normalizeStr(v.Round_Name) === normalizeStr(roundName) && parseInt(v.GD_Group_Size, 10) > 0);
    groupSize = a ? parseInt(a.GD_Group_Size, 10) : 20;
  }
  groupSize = Math.max(1, groupSize);
  const counts = {};
  const ungrouped = [];
  rows.forEach(r => {
    const g = r.Group_No;
    if (g === '' || g === null || g === undefined) { ungrouped.push({ Enrollment_No: r.Enrollment_No, Student_Name: r.Student_Name }); return; }
    const n = Number(g);
    if (!isNaN(n)) counts[n] = (counts[n] || 0) + 1;
  });
  return {
    success: true, groupSize: groupSize,
    groupMode: roundRow ? normalizeStr(roundRow.Group_Mode) || 'Random' : 'Random',
    counts: counts, ungrouped: ungrouped,
    roundStatus: roundRow ? normalizeStr(roundRow.Round_Status) : ''
  };
}

async function getVolunteerRoundBoard(companyName, roundName, pullFirst, volunteerMobile) {
  // access check (same as assertVolunteerRoundAccess_)
  const needAccessCheck = volunteerMobile && normalizeMobileDigits(volunteerMobile).length >= 10;
  const [rndVals, volVals] = await Promise.all([
    getSheetOrNull('Rnd__' + sanitizeForSheetName(companyName)),
    needAccessCheck ? getOneSheet('Round_Volunteers') : Promise.resolve([])]);
  if (needAccessCheck && volVals.length >= 2) {
    const m = normalizeMobileDigits(volunteerMobile);
    const h = volVals[0];
    const ci = h.indexOf('Company_Name'), ri = h.indexOf('Round_Name'), mi = h.indexOf('Volunteer_Mobile'), si = h.indexOf('Access_Status');
    let status = '';
    for (let i = 1; i < volVals.length; i++) {
      const row = volVals[i];
      if (normalizeStr(row[ci]) === normalizeStr(companyName) && normalizeStr(row[ri]) === normalizeStr(roundName) &&
          normalizeMobileDigits(row[mi]) === m) { status = normalizeAccessStatus(row[si]); break; }
    }
    if (status === 'Paused') return { success: false, accessPaused: true, message: 'Your access to this round has been paused by the admin. Please check back later.' };
    if (status === 'Stopped') return { success: false, accessStopped: true, message: 'Your access to this round has been removed by the admin.' };
  }
  if (rndVals === null || rndVals.length < 2) return { success: true, data: [] };
  const roundIdx = rndVals[0].indexOf('Round_Name');
  const wantRound = normalizeStr(roundName);
  const all = toObjects(rndVals, 'auto');
  const rows = all.filter(o => normalizeStr(roundIdx === -1 ? undefined : o[rndVals[0][roundIdx]]) === wantRound);
  rows.sort((a, b) =>
    (Number(a.Group_No) || 0) - (Number(b.Group_No) || 0) ||
    String(a.Student_Name || '').localeCompare(String(b.Student_Name || '')));
  return { success: true, data: rows };
}

// ---------- volunteer login + "open round" sync (check-only; Apps Script still does any writing) ----------
// These mobile numbers always get admin access. Set PERMANENT_ADMIN_MOBILES in Vercel (comma separated) if you
// changed the list in VolunteerBackend.gs; if a number is not found here the request is re-checked by Apps Script anyway.
const PERMANENT_ADMIN_MOBILES = String(process.env.PERMANENT_ADMIN_MOBILES || '9999999999,8888888888')
  .split(',').map(x => x.trim()).filter(Boolean);

function volunteerAccessBlock(volVals, companyName, roundName, volunteerMobile) {
  if (!volunteerMobile) return null;
  const m = normalizeMobileDigits(volunteerMobile);
  if (m.length < 10) return null;
  if (!volVals || volVals.length < 2) return null;
  const h = volVals[0];
  const ci = h.indexOf('Company_Name'), ri = h.indexOf('Round_Name'), mi = h.indexOf('Volunteer_Mobile'), si = h.indexOf('Access_Status');
  let status = '';
  for (let i = 1; i < volVals.length; i++) {
    const row = volVals[i];
    if (normalizeStr(row[ci]) === normalizeStr(companyName) && normalizeStr(row[ri]) === normalizeStr(roundName) &&
        normalizeMobileDigits(row[mi]) === m) { status = normalizeAccessStatus(row[si]); break; }
  }
  if (status === 'Paused') return { success: false, accessPaused: true, message: 'Your access to this round has been paused by the admin. Please check back later.' };
  if (status === 'Stopped') return { success: false, accessStopped: true, message: 'Your access to this round has been removed by the admin.' };
  return null;
}

// Would syncAdminVolunteerRounds_ add rows? (true = Apps Script must do it)
function adminRoundSyncWouldAdd(volRows, allRounds, wantedCompany) {
  const wanted = wantedCompany ? normalizeStr(wantedCompany) : null;
  const people = {};
  volRows.forEach(r => {
    const co = normalizeStr(r.Company_Name);
    if (!co || (wanted && co !== wanted)) return;
    const m = normalizeMobileDigits(r.Volunteer_Mobile);
    if (m.length < 10) return;
    if (!people[co]) people[co] = {};
    if (!people[co][m]) people[co][m] = { isAdmin: false, active: false, has: {} };
    const a = people[co][m];
    if (normalizeStr(r.Role).toLowerCase() === 'admin') {
      a.isAdmin = true;
      if (normalizeAccessStatus(r.Access_Status) !== 'Stopped') a.active = true;
    }
    a.has[normalizeStr(r.Round_Name).toLowerCase()] = true;
  });
  const admins = {};
  Object.keys(people).forEach(co => Object.keys(people[co]).forEach(m => {
    if (people[co][m].isAdmin) { (admins[co] = admins[co] || {})[m] = people[co][m]; }
  }));
  const companies = Object.keys(admins);
  if (!companies.length) return false;
  const roundsByCompany = {};
  allRounds.forEach(r => {
    const co = normalizeStr(r.Company_Name);
    if (!admins[co]) return;
    (roundsByCompany[co] = roundsByCompany[co] || []).push(normalizeStr(r.Round_Name));
  });
  for (const co of companies) {
    const roundNames = ['Attendance'].concat(roundsByCompany[co] || []);
    for (const m of Object.keys(admins[co])) {
      const a = admins[co][m];
      if (!a.active) continue;
      for (const rn of roundNames) {
        if (!rn || a.has[rn.toLowerCase()]) continue;
        return true;
      }
    }
  }
  return false;
}

async function volunteerLogin(mobile) {
  const m = normalizeMobileDigits(mobile);
  if (m.length < 10) return { success: false, message: 'Enter a valid 10-digit mobile number.' };
  const [compVals, procVals, volVals, attVals] = await Promise.all([
    getOneSheet('Companies_Master'), getOneSheet('Process_Tracking'), getOneSheet('Round_Volunteers'), getOneSheet('Attendance_Sessions')]);
  const companiesData = compVals.length > 1 ? toObjects(compVals, { Date: true }, withExpected(compVals[0], COMPANIES_HEADERS)) : [];
  const running = {};
  companiesData.forEach(c => { if (normalizeStr(c.Status) !== 'Completed') running[normalizeStr(c.Company_Name)] = true; });
  const allRounds = procVals.length > 1 ? toObjects(procVals, null, withExpected(procVals[0], ROUNDS_HEADERS)) : [];
  const isPermanentAdmin = PERMANENT_ADMIN_MOBILES.some(p => normalizeMobileDigits(p) === m);
  let rows;
  if (isPermanentAdmin) {
    rows = [];
    companiesData.forEach(c => {
      if (normalizeStr(c.Status) === 'Completed') return;
      const roundNames = allRounds.filter(r => normalizeStr(r.Company_Name) === normalizeStr(c.Company_Name)).map(r => r.Round_Name);
      ['Attendance'].concat(roundNames).forEach(roundName => {
        rows.push({ Company_Name: c.Company_Name, Round_Name: roundName, Round_Type: '', GD_Group_Size: '', Volunteer_Mobile: mobile,
          Volunteer_Name: 'Admin', Assigned_Groups: '', Role: 'Admin', Access_Status: 'Active' });
      });
    });
  } else {
    const vols = volVals.length > 1 ? toObjects(volVals, 'auto', withExpected(volVals[0], ROUND_VOLUNTEERS_HEADERS)) : [];
    if (adminRoundSyncWouldAdd(vols, allRounds)) throw new Error('admin rounds need syncing (handled by Apps Script)');
    rows = vols.filter(r => normalizeMobileDigits(r.Volunteer_Mobile) === m && running[normalizeStr(r.Company_Name)]
      && normalizeAccessStatus(r.Access_Status) !== 'Stopped');
  }
  if (!rows.length) throw new Error('no assignment found (Apps Script double-checks this)');
  const roundsByCo = {};
  allRounds.forEach(r => {
    const co = normalizeStr(r.Company_Name);
    (roundsByCo[co] = roundsByCo[co] || []).push(normalizeStr(r.Round_Name));
  });
  const attObjs = attVals.length > 1 ? toObjects(attVals, 'auto') : [];
  const ts = v => (typeof v === 'number') ? v : new Date(String(v)).getTime();
  const openSessions = company => attObjs
    .filter(r => normalizeStr(r.Company_Name) === normalizeStr(company) && normalizeStr(r.Status) === 'Open')
    .sort((a, b) => { const d = ts(b.Created_At) - ts(a.Created_At); return isNaN(d) ? 0 : d; })
    .map(r => ({ Session_ID: r.Session_ID, Session_Name: r.Session_Name || 'Attendance', Registration_Mode: r.Registration_Mode || 'prior' }));
  const attByCo = {};
  return {
    success: true, mobile: m, isPermanentAdmin: isPermanentAdmin,
    assignments: rows.map(r => {
      const isAttendance = normalizeStr(r.Round_Name).toUpperCase() === 'ATTENDANCE';
      return {
        Company_Name: r.Company_Name, Round_Name: r.Round_Name, Round_Type: r.Round_Type || r.Round_Name,
        GD_Group_Size: r.GD_Group_Size, Volunteer_Name: r.Volunteer_Name, Volunteer_Mobile: r.Volunteer_Mobile || mobile,
        Assigned_Groups: r.Assigned_Groups || '', Role: r.Role === 'Admin' ? 'Admin' : 'Volunteer',
        Access_Status: normalizeAccessStatus(r.Access_Status), IsAttendance: isAttendance,
        IsFinalRound: isAttendance ? false : (function () {
          const list = roundsByCo[normalizeStr(r.Company_Name)] || [];
          const i = list.indexOf(normalizeStr(r.Round_Name));
          return i !== -1 && i === list.length - 1;
        })(),
        Attendance_Sessions: isAttendance
          ? (attByCo[normalizeStr(r.Company_Name)] = attByCo[normalizeStr(r.Company_Name)] || openSessions(r.Company_Name))
          : []
      };
    })
  };
}

// Runs every time a volunteer opens a round. Almost always there is nothing to do; in that case answer at once.
// If students must be pulled in or carried forward, Apps Script (which does the writing) is asked instead.
async function syncVolunteerRoundOnOpen(companyName, roundName, volunteerMobile) {
  const safe = sanitizeForSheetName(companyName);
  const [procVals, rndVals, regVals, volVals] = await Promise.all([
    getOneSheet('Process_Tracking'), getSheetOrNull('Rnd__' + safe), getSheetOrNull('Reg__' + safe),
    volunteerMobile ? getOneSheet('Round_Volunteers') : Promise.resolve([])]);
  const blocked = volunteerAccessBlock(volVals, companyName, roundName, volunteerMobile);
  if (blocked) return blocked;

  const companyRounds = (procVals.length > 1 ? toObjects(procVals, null, withExpected(procVals[0], ROUNDS_HEADERS)) : [])
    .filter(r => normalizeStr(r.Company_Name) === normalizeStr(companyName));
  const rround = [], renroll = [], rresult = [];
  if (rndVals && rndVals.length >= 2) {
    const h = rndVals[0];
    const ri = h.indexOf('Round_Name'), ei = h.indexOf('Enrollment_No'), xi = h.indexOf('Result');
    for (let i = 1; i < rndVals.length; i++) {
      rround.push(normalizeStr(rndVals[i][ri]));
      renroll.push(normEnroll(rndVals[i][ei]));
      rresult.push(xi >= 0 ? normalizeStr(rndVals[i][xi]) : '');
    }
  }
  const inRound = {};
  rround.forEach((rn, i) => { (inRound[rn] = inRound[rn] || {})[renroll[i]] = true; });
  const isFirst = companyRounds.length && normalizeStr(companyRounds[0].Round_Name) === normalizeStr(roundName);
  if (isFirst && regVals && regVals.length >= 2) {
    const rh = regVals[0];
    const rEn = rh.indexOf('Enrollment_No') + 1, rAt = rh.indexOf('Attendance') + 1;
    if (rEn > 0 && rAt > 0) {
      const have = inRound[normalizeStr(roundName)] || {};
      for (let i = 1; i < regVals.length; i++) {
        if (normalizeStr(regVals[i][rAt - 1]).toUpperCase() !== 'PRESENT') continue;
        const k = normEnroll(regVals[i][rEn - 1]);
        if (k && !have[k]) throw new Error('students to pull in (handled by Apps Script)');
      }
    }
  }
  for (let ci = 0; ci < companyRounds.length; ci++) {
    const rn = normalizeStr(companyRounds[ci].Round_Name);
    const isLast = ci === companyRounds.length - 1;
    const nextHave = isLast ? null : (inRound[normalizeStr(companyRounds[ci + 1].Round_Name)] || {});
    for (let i = 0; i < rround.length; i++) {
      if (rround[i] !== rn || rresult[i] !== 'Shortlisted') continue;
      if (isLast || !nextHave[renroll[i]]) throw new Error('students to carry forward (handled by Apps Script)');
    }
  }
  return { success: true, changed: false };
}

// ---------- Excel export (Apps Script took ~6.5 s: it builds a temporary Google Sheet, formats it, exports it, trashes it) ----------
// Builds the same banner + header + bordered table directly as an .xlsx file. PDF is still built by Apps Script.
const EXPORT_BANNER_ROW_HEIGHT_PX = 30;
const EXPORT_ROW_HEIGHT_PX = 22;

function computeExportColumnWidths(fields, rows) {
  return fields.map(f => {
    let maxLen = String(f.label || '').length;
    rows.forEach(r => {
      const v = r[f.key];
      const len = (v === undefined || v === null) ? 0 : String(v).length;
      if (len > maxLen) maxLen = len;
    });
    return Math.max(60, Math.min(Math.round(maxLen * 7.2) + 24, 300));
  });
}

async function exportFormattedFile(title, fields, rows, format) {
  if (format === 'pdf') throw new Error('PDF is built by Apps Script');
  if (!fields || !fields.length) return { success: false, message: 'No columns to export.' };
  const bannerLines = (Array.isArray(title) ? title : [title]).map(t => t || '').filter(t => t !== '');
  if (!bannerLines.length) bannerLines.push('Export');
  rows = rows || [];
  const ExcelJS = require('exceljs');
  const numCols = fields.length;
  const bannerRowCount = bannerLines.length;
  const headerRow = bannerRowCount + 1;
  const dataStartRow = bannerRowCount + 2;
  const totalRows = rows.length + headerRow;
  const px2pt = px => px * 0.75;
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export', { views: [{ state: 'frozen', ySplit: headerRow }] });

  const widths = computeExportColumnWidths(fields, rows);
  if (fields[0] && fields[0].key === '_sno') widths[0] = 50;
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = Math.max(1, (w - 5) / 7); });

  // banner
  bannerLines.forEach((line, i) => {
    const rowNum = i + 1;
    const isFirst = i === 0;
    const isLast = i === bannerRowCount - 1 && bannerRowCount > 1;
    for (let c = 1; c <= numCols; c++) {
      const cell = ws.getCell(rowNum, c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
      cell.border = border;
    }
    if (numCols > 1) ws.mergeCells(rowNum, 1, rowNum, numCols);
    const cell = ws.getCell(rowNum, 1);
    cell.value = line;
    cell.font = { name: 'Arial', bold: !isLast, size: isFirst ? 13 : (isLast ? 10 : 12), color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getRow(rowNum).height = px2pt(EXPORT_BANNER_ROW_HEIGHT_PX);
  });

  // header
  fields.forEach((f, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = f.label;
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF1E1B4B' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = border;
  });
  ws.getRow(headerRow).height = px2pt(EXPORT_ROW_HEIGHT_PX);

  // data
  rows.forEach((r, ri) => {
    const rowNum = dataStartRow + ri;
    fields.forEach((f, ci) => {
      const v = r[f.key];
      const cell = ws.getCell(rowNum, ci + 1);
      cell.value = (v === undefined || v === null) ? '' : v;
      cell.font = { name: 'Arial', size: 10 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = border;
    });
    ws.getRow(rowNum).height = px2pt(EXPORT_ROW_HEIGHT_PX);
  });

  const buf = await wb.xlsx.writeBuffer();
  const safeTitle = bannerLines.join('_').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Export';
  return {
    success: true, base64: Buffer.from(buf).toString('base64'),
    fileName: safeTitle + '.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

// ---------- student registration form: the two reads every student's phone makes first ----------
function tzOffsetMs(instant, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const g = t => parseInt(p.find(x => x.type === t).value, 10);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(instant / 1000) * 1000;
}
// A date typed into the sheet comes back as a serial number in the sheet's time zone; Apps Script gave a real instant.
function serialToIsoInstant(serial, tz) {
  const localMs = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
  let guess = localMs - tzOffsetMs(localMs, tz);
  guess = localMs - tzOffsetMs(guess, tz);
  return new Date(guess).toISOString();
}


// ---------- eligible courses / branches (mirrors Code.gs) ----------
function normalizeEligibleCourses(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  FORM_COURSE_OPTIONS.forEach(course => {
    if (!Object.prototype.hasOwnProperty.call(raw, course)) return;
    const allowed = BRANCH_OPTIONS_BY_COURSE[course] || [];
    const picked = Array.isArray(raw[course]) ? raw[course] : [];
    out[course] = allowed.filter(b => picked.indexOf(b) !== -1);
  });
  return out;
}
function hasEligibilityRestriction(eligible) { return !!eligible && Object.keys(eligible).length > 0; }
function eligibleFormOptions(eligible) {
  if (!hasEligibilityRestriction(eligible)) return { courseOptions: FORM_COURSE_OPTIONS, branchOptionsByCourse: BRANCH_OPTIONS_BY_COURSE };
  const map = {};
  const courses = FORM_COURSE_OPTIONS.filter(c => !!eligible[c]);
  courses.forEach(c => { map[c] = eligible[c].slice(); });
  return { courseOptions: courses, branchOptionsByCourse: map };
}
function branchEligibilityMessage(eligible, masterBranch, displayName) {
  if (!hasEligibilityRestriction(eligible)) return '';
  const b = normalizeStr(masterBranch).toLowerCase();
  if (!b) return '';
  const allowed = {}, known = {};
  Object.keys(BRANCH_OPTIONS_BY_COURSE).forEach(c => BRANCH_OPTIONS_BY_COURSE[c].forEach(x => { known[x.toLowerCase()] = true; }));
  Object.keys(eligible).forEach(c => (eligible[c] || []).forEach(x => { allowed[x.toLowerCase()] = true; }));
  if (!known[b] || allowed[b]) return '';
  const summary = Object.keys(eligible).map(c => c + ' (' + (eligible[c] || []).join(', ') + ')').join('; ');
  return 'Dear ' + displayName + ', your branch (' + normalizeStr(masterBranch) + ') is not eligible for this drive. Eligible: ' + summary + '.';
}

async function readRegFormConfigFull(cfgVals, companyName, tz) {
  const none = { found: false, fields: [], includeCV: false, criteria: {}, companyDescription: '', placedAllowed: true,
    excludedCompanies: [], closesAt: '', customQuestions: normalizeCustomQuestions([]), eligibleCourses: {} };
  if (!cfgVals || cfgVals.length < 2) return none;
  const ci = cfgVals[0].indexOf('Company_Name');
  if (ci === -1) return none;
  const row = findCompanyRow(cfgVals.slice(1), ci, companyName);
  if (!row) return none;
  const obj = regConfigObject(cfgVals[0], row);
  let fields = [], criteria = {}, raw = [];
  try { fields = JSON.parse(obj.Fields_JSON || '[]'); } catch (e) { fields = []; }
  try { criteria = JSON.parse(obj.Criteria_JSON || '{}'); } catch (e) { criteria = {}; }
  try { raw = JSON.parse(obj.Custom_Questions_JSON || '[]'); } catch (e) { raw = []; }
  let rawEligible = {};
  try { rawEligible = JSON.parse(obj.Eligible_Courses_JSON || '{}'); } catch (e) { rawEligible = {}; }
  const closesAt = (typeof obj.Closes_At === 'number') ? serialToIsoInstant(obj.Closes_At, tz) : '';
  return {
    found: true, fields: fields,
    includeCV: obj.Include_CV === true || obj.Include_CV === 'TRUE' || obj.Include_CV === 'true',
    criteria: criteria, companyDescription: obj.Company_Description || '',
    placedAllowed: obj.Placed_Allowed !== false && obj.Placed_Allowed !== 'FALSE' && obj.Placed_Allowed !== 'false',
    excludedCompanies: (obj.Excluded_Companies || '').toString().split(',').map(x => normalizeStr(x)).filter(Boolean),
    closesAt: closesAt, customQuestions: normalizeCustomQuestions(raw), eligibleCourses: normalizeEligibleCourses(rawEligible)
  };
}

async function getRegistrationFormForCompany(companyName) {
  if (!normalizeStr(companyName)) return { success: false, message: 'No company specified. Ask the admin for the correct registration link.' };
  const [cfgVals, compVals, tz] = await Promise.all([getOneSheet('Registration_Form_Config'), getOneSheet('Companies_Master'), googleLib.getSpreadsheetTimeZone()]);
  const cfg = await readRegFormConfigFull(cfgVals, companyName, tz);
  // The fast path must never be the one to say "not set up": if it cannot find the row, hand over to Apps Script
  // (call.js turns this error into {fallback:true}), which reads the real config and gives the true answer.
  if (!cfg.found) throw new Error('registration config row not found in Sheets read; deferring to Apps Script');
  const defByKey = {};
  REGC.REGISTRATION_FORM_FIELD_DEFS.forEach(f => { defByKey[f.key] = f; });
  const fields = cfg.fields
    .map(k => defByKey[k])
    .filter(Boolean)
    .map(f => ({
      key: f.key, label: f.label, type: f.type,
      minRequired: (f.hasCriteria && cfg.criteria && cfg.criteria[f.key] !== undefined) ? cfg.criteria[f.key] : null
    }))
    .sort((a, b) => (a.key === 'Course' ? -1 : b.key === 'Course' ? 1 : 0));
  const customQuestions = cfg.customQuestions
    .map((q, i) => Object.assign({ key: CUSTOM_Q_KEYS[i] }, q))
    .filter(q => q.enabled);
  let jdFileName = '', jdFileUrl = '';
  if (compVals.length > 1) {
    const h = compVals[0];
    const ci = h.indexOf('Company_Name');
    const row = findCompanyRow(compVals.slice(1), ci, companyName);
    if (row) {
      const ni = h.indexOf('JD_File_Name'), ui = h.indexOf('JD_File_URL');
      if (ni !== -1) jdFileName = row[ni] || '';
      if (ui !== -1) jdFileUrl = row[ui] || '';
    }
  }
  const currentYear = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(new Date()), 10);
  const years = [];
  for (let y = currentYear; y >= 2000; y--) years.push(String(y));
  return {
    success: true, companyName: companyName, companyDescription: cfg.companyDescription || '',
    jdFileName: jdFileName, jdFileUrl: jdFileUrl, fields: fields, customQuestions: customQuestions,
    includeCV: cfg.includeCV, maxCVSizeBytes: REGC.MAX_CV_FILE_SIZE_BYTES,
    closesAt: cfg.closesAt || '',
    isClosed: !!(cfg.closesAt && new Date(cfg.closesAt).getTime() <= Date.now()),
    branchOptionsByCourse: eligibleFormOptions(cfg.eligibleCourses).branchOptionsByCourse,
    collegeOptions: FORM_COLLEGE_OPTIONS, genderOptions: REGC.REGISTRATION_FORM_GENDER_OPTIONS,
    categoryOptions: REGC.REGISTRATION_FORM_CATEGORY_OPTIONS, gradDegreeOptions: REGC.REGISTRATION_FORM_GRAD_DEGREE_OPTIONS,
    courseOptions: eligibleFormOptions(cfg.eligibleCourses).courseOptions, gapOptions: REGC.REGISTRATION_FORM_GAP_OPTIONS,
    boardOptions: REGC.REGISTRATION_FORM_BOARD_OPTIONS, mediumOptions: REGC.REGISTRATION_FORM_MEDIUM_OPTIONS,
    yearOptions: years
  };
}

async function checkRegistrationEligibility(companyName, enrollmentNo) {
  if (!normalizeStr(companyName)) return { success: false, message: 'No company specified.' };
  if (!normEnroll(enrollmentNo)) return { success: false, message: 'Enrollment number is required.' };
  if (/\s/.test(normalizeStr(enrollmentNo))) return { success: false, message: 'Enrollment number cannot contain any spaces.' };
  const [cfgVals, regVals, tz] = await Promise.all([
    getOneSheet('Registration_Form_Config'), getOneSheet('Reg__' + sanitizeForSheetName(companyName)), googleLib.getSpreadsheetTimeZone()]);
  const cfg = await readRegFormConfigFull(cfgVals, companyName, tz);
  if (!cfg.found) throw new Error('registration config row not found in Sheets read; deferring to Apps Script');
  if (cfg.closesAt) {
    const closesAtDate = new Date(cfg.closesAt);
    if (!isNaN(closesAtDate.getTime()) && Date.now() > closesAtDate.getTime()) {
      return { success: false, message: 'Registration for this drive has closed.', closed: true };
    }
  }
  if (regVals.length > 1) {
    const ei = regVals[0].indexOf('Enrollment_No');
    const key = normEnroll(enrollmentNo);
    if (ei !== -1 && regVals.slice(1).some(r => normEnroll(r[ei]) === key)) {
      return { success: false, message: 'You have already registered for this drive.' };
    }
  }
  const master = await getMaster();
  const masterRecord = master.map[normEnroll(enrollmentNo)];
  const studentDisplayName = (masterRecord && masterRecord.Name) || 'Student';
  const branchMsg = branchEligibilityMessage(cfg.eligibleCourses, masterRecord && masterRecord.Branch, studentDisplayName);
  if (branchMsg) return { success: false, message: branchMsg };
  if (cfg.placedAllowed === false || (cfg.excludedCompanies && cfg.excludedCompanies.length > 0)) {
    const selected = toObjects(await getOneSheet('Selected_Students'));
    const studentCompanies = [];
    const key = normEnroll(enrollmentNo);
    selected.forEach(st => { if (normEnroll(st.Enrollment_No) === key) studentCompanies.push(normalizeStr(st.Company_Name)); });
    if (studentCompanies.length > 0) {
      if (cfg.placedAllowed === false) {
        return { success: false, message: 'Dear ' + studentDisplayName + ', you have already selected in ' + studentCompanies.join(', ') + ', you are not allowed in this drive.' };
      }
      const excludedSet = {};
      (cfg.excludedCompanies || []).forEach(c => { excludedSet[normalizeStr(c).toLowerCase()] = true; });
      const blockedCompany = studentCompanies.find(c => excludedSet[normalizeStr(c).toLowerCase()]);
      if (blockedCompany) {
        return { success: false, message: 'Dear ' + studentDisplayName + ', you have already selected in ' + blockedCompany + ', you are not allowed in this drive.' };
      }
    }
  }
  return { success: true };
}

// ---------- attendance status, volunteer mobile check, photo request, student feedback form ----------
function findSessionRow(vals, sessionId) {
  if (!vals || vals.length < 2) return null;
  const h = vals[0];
  const si = h.indexOf('Session_ID');
  if (si === -1) return null;
  const want = normEnroll(sessionId);
  let rowIdx = -1;
  for (let i = 1; i < vals.length; i++) { if (normEnroll(vals[i][si]) === want) { rowIdx = i; break; } }
  if (rowIdx < 1) return null;
  const obj = {};
  h.forEach((hh, j) => { const v = vals[rowIdx][j]; obj[hh] = (v === undefined || v === null) ? '' : v; });
  return obj;
}

async function getAttendanceSessionStatus(sessionId) {
  const attVals = await getOneSheet('Attendance_Sessions');
  const session = findSessionRow(attVals, sessionId);
  if (!session) return { success: false, message: 'Session not found.' };
  const regVals = await getOneSheet('Reg__' + sanitizeForSheetName(session.Company_Name));
  const registered = regVals.length > 1 ? toObjects(regVals, 'auto') : [];
  return {
    success: true, status: session.Status, companyName: session.Company_Name, sessionName: session.Session_Name,
    presentCount: registered.filter(r => r.Attendance === 'Present').length, registeredCount: registered.length
  };
}

async function verifyVolunteerMobile(sessionId, mobile) {
  const [attVals, volVals] = await Promise.all([getOneSheet('Attendance_Sessions'), getOneSheet('Round_Volunteers')]);
  const session = findSessionRow(attVals, sessionId);
  if (!session) return { success: false, message: 'Session not found. This link may have been removed.' };
  const entered = normalizeMobileDigits(mobile);
  if (!entered || entered.length < 6) return { success: false, message: 'Please enter a valid mobile number.' };
  const vols = volVals.length > 1 ? toObjects(volVals, 'auto', withExpected(volVals[0], ROUND_VOLUNTEERS_HEADERS)) : [];
  const assigned = vols.some(r =>
    normalizeStr(r.Company_Name) === normalizeStr(session.Company_Name) &&
    normalizeStr(r.Round_Name).toUpperCase() === 'ATTENDANCE' &&
    normalizeMobileDigits(r.Volunteer_Mobile) === entered);
  if (!assigned) {
    return { success: false, message: 'This mobile number is not assigned as an Attendance volunteer for ' + session.Company_Name +
      '. Ask the admin to assign it under "Manage Volunteers" → Round: Attendance.' };
  }
  return { success: true };
}

async function getPhotoRequestForStudent(companyName, enrollmentNo) {
  if (!normalizeStr(companyName)) return { success: false, message: 'No company specified in this link.' };
  if (!normalizeStr(enrollmentNo)) return { success: false, message: 'Please enter your Enrollment Number.' };
  const allRows = selectedStudentObjects(await getOneSheet('Selected_Students'));
  const normCo = v => normEnroll(v).replace(/\s+/g, ' ');
  let row = allRows.find(r => normCo(r.Company_Name) === normCo(companyName) && normEnroll(r.Enrollment_No) === normEnroll(enrollmentNo));
  if (!row) {
    const candidates = allRows.filter(r => normEnroll(r.Enrollment_No) === normEnroll(enrollmentNo));
    if (candidates.length === 1) row = candidates[0];
    else if (candidates.length > 1) {
      const looseTarget = looseName(companyName);
      const looseMatches = candidates.filter(r => looseName(r.Company_Name) === looseTarget);
      if (looseMatches.length === 1) row = looseMatches[0];
    }
  }
  if (!row) {
    return { success: false, message: 'We could not find you in the selected list for ' + companyName + '. Check your Enrollment Number, or contact the Placement Cell.' };
  }
  // a better photo record for the same student (any other row of the same company) wins
  const wanted = looseName(companyName);
  const best = {};
  allRows.map(r => Object.assign({}, r)).forEach(r => {
    if (looseName(r.Company_Name) !== wanted) return;
    const k = looseName(r.Enrollment_No);
    if (!k) return;
    if (!best[k] || photoRank(r) > photoRank(best[k])) best[k] = r;
  });
  const donor = best[looseName(row.Enrollment_No)];
  if (donor && photoRank(donor) > photoRank(row)) PHOTO_FIELDS.forEach(f => { row[f] = donor[f]; });
  return {
    success: true, studentName: row.Student_Name || '',
    alreadySubmitted: normalizeStr(row.Photo_Status) === 'Submitted',
    submittedAt: row.Photo_Submitted_At || '', companyName: row.Company_Name || companyName
  };
}

async function getFeedbackFormForStudent(companyName, enrollmentNo) {
  companyName = normalizeStr(companyName);
  if (!companyName) return { success: false, message: 'Missing company.' };
  const safe = sanitizeForSheetName(companyName);
  const [compVals, procVals, rndVals, fdbkVals] = await Promise.all([
    getOneSheet('Companies_Master'), getOneSheet('Process_Tracking'), getSheetOrNull('Rnd__' + safe), getSheetOrNull('Fdbk__' + safe)]);
  const companies = compVals.length > 1 ? toObjects(compVals, { Date: true }, withExpected(compVals[0], COMPANIES_HEADERS)) : [];
  if (!companies.find(c => normalizeStr(c.Company_Name) === companyName)) return { success: false, message: 'Company not found.' };

  const rounds = (procVals.length > 1 ? toObjects(procVals, null, withExpected(procVals[0], ROUNDS_HEADERS)) : [])
    .filter(r => normalizeStr(r.Company_Name) === companyName);
  if (!rounds.length) return { success: false, message: 'This company does not have any rounds set up yet.' };
  const lastRound = rounds[rounds.length - 1];
  if (rndVals === null) return { success: false, message: 'No round data found yet for this company.' };
  const key = normEnroll(enrollmentNo);
  if (!key) return { success: false, message: 'Please enter your Enrollment Number.' };
  const match = (rndVals.length > 1 ? toObjects(rndVals, 'auto') : []).find(rs =>
    normalizeStr(rs.Round_Name) === normalizeStr(lastRound.Round_Name) && normEnroll(rs.Enrollment_No) === key);
  if (!match) {
    return { success: false, message: 'We could not find you in the final round (' + lastRound.Round_Name + ') for this company, so the feedback form is not open for you yet.' };
  }
  const schema = rounds.map(r => {
    const roundName = normalizeStr(r.Round_Name);
    if (/gd|group\s*discussion/i.test(roundName)) {
      return { Round_Name: roundName, type: 'gd', fields: [{ key: roundName + ' — Topic', label: 'GD Topic', placeholder: 'What topic was given for this Group Discussion?' }] };
    }
    const fields = [];
    for (let i = 1; i <= 5; i++) fields.push({ key: roundName + ' — Q' + i, label: 'Question ' + i, placeholder: 'A question you were asked in this round (optional)' });
    return { Round_Name: roundName, type: 'interview', fields: fields };
  });
  const existing = (fdbkVals && fdbkVals.length > 1 ? toObjects(fdbkVals, 'auto') : []).find(row => normEnroll(row.Enrollment_No) === key) || null;
  return { success: true, companyName: companyName, studentName: normalizeStr(match.Student_Name), schema: schema, existing: existing };
}

// ---------- kiosk QR code (read-only: the code is a fingerprint of a secret in the session row and the current time slot) ----------
const QR_ROTATION_SECONDS = 75;
function frontendBase() {
  const b = process.env.FRONTEND_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : 'https://mastertpo.vercel.app');
  return b.replace(/\/+$/, '') + '/';
}
function parsePlacementRule(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const obj = JSON.parse(String(raw));
    if (!obj || !Array.isArray(obj.blocked)) return null;
    return { blocked: obj.blocked.map(normalizeStr).filter(Boolean) };
  } catch (err) { return null; }
}
// A date-time typed into the sheet is a serial number in the sheet's own time zone; Apps Script printed it as yyyy-MM-ddTHH:mm:ss.
function serialToLocalIso(v) {
  if (typeof v !== 'number') return v;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)).toISOString().slice(0, 19);
}
function sessionPublic(s) {
  const rule = parsePlacementRule(s.Placement_Rule);
  return {
    Session_ID: s.Session_ID, Company_Name: s.Company_Name, Session_Name: s.Session_Name,
    Round_Name: s.Round_Name, Status: s.Status, Start_Time: serialToLocalIso(s.Start_Time), End_Time: serialToLocalIso(s.End_Time),
    Registration_Mode: s.Registration_Mode || 'prior',
    Placement_Rule_Set: rule !== null,
    Blocked_Companies: (rule || { blocked: [] }).blocked
  };
}
function computeAttendanceToken(secret, sessionId, slot) {
  return nodeCrypto.createHmac('sha256', String(secret)).update(sessionId + '|' + slot).digest('hex').substring(0, 10);
}

async function getCurrentAttendanceToken(sessionId) {
  const session = findSessionRow(await getOneSheet('Attendance_Sessions'), sessionId);
  if (!session) return { success: false, message: 'Session not found. This link may have been removed.' };
  if (session.Status !== 'Open') {
    return { success: false, ended: true, message: 'This attendance session has ended.', session: sessionPublic(session) };
  }
  const nowMs = Date.now();
  const slot = Math.floor(nowMs / (QR_ROTATION_SECONDS * 1000));
  const token = computeAttendanceToken(session.QR_Secret, sessionId, slot);
  const secondsRemaining = QR_ROTATION_SECONDS - (Math.floor(nowMs / 1000) % QR_ROTATION_SECONDS);
  const mode = session.Registration_Mode === 'spot' ? 'spot' : 'prior';
  return {
    success: true, token: token,
    checkinUrl: frontendBase() + '?page=checkin&session=' + encodeURIComponent(sessionId) + '&t=' + token + '&mode=' + mode,
    secondsRemaining: secondsRemaining, rotationSeconds: QR_ROTATION_SECONDS, session: sessionPublic(session)
  };
}

// ---------- admin "Volunteers" live overview (Apps Script spent ~20 s here, mostly re-checking every assigned round for carry-forward) ----------
// Answers straight from the sheets when nothing needs repairing. If a repair WOULD be needed (a Round_Volunteers row naming a
// company that does not exist, or shortlisted students not yet carried forward), Apps Script is asked, because it does the writing.
async function getSheetsThatExist(names) {
  const titles = await getSheetTitles();
  const have = names.filter(n => titles.indexOf(n) !== -1);
  const data = have.length ? await getSheets(have) : {};
  const out = {};
  names.forEach(n => { out[n] = have.indexOf(n) !== -1 ? (data[n] || []) : null; });
  return out;
}

async function getVolunteerLiveOverview() {
  const [volVals, compVals, procVals, selVals] = await Promise.all([
    getOneSheet('Round_Volunteers'), getOneSheet('Companies_Master'), getOneSheet('Process_Tracking'), getOneSheet('Selected_Students')]);
  const companies = compVals.length > 1 ? toObjects(compVals, { Date: true }, withExpected(compVals[0], COMPANIES_HEADERS)) : [];
  const vols = volVals.length > 1 ? toObjects(volVals, 'auto', withExpected(volVals[0], ROUND_VOLUNTEERS_HEADERS)) : [];

  // repair 1: a volunteer row whose company name is not exactly a live company name
  const liveNames = {};
  companies.forEach(c => { liveNames[c.Company_Name] = true; });
  if (vols.some(a => { const n = String(a.Company_Name == null ? '' : a.Company_Name); return n && !liveNames[n]; })) {
    throw new Error('a volunteer row names an unknown company (Apps Script repairs this)');
  }

  const completed = {};
  companies.forEach(c => { if (normalizeStr(c.Status) === 'Completed') completed[normalizeStr(c.Company_Name)] = true; });
  const assignments = vols.filter(a => !completed[normalizeStr(a.Company_Name)]);

  const allRounds = procVals.length > 1 ? toObjects(procVals, null, withExpected(procVals[0], ROUNDS_HEADERS)) : [];
  const involved = {};
  assignments.forEach(a => { const c = normalizeStr(a.Company_Name); if (c) involved[c] = true; });
  const companyNames = Object.keys(involved);
  const sheetNames = companyNames.map(c => 'Rnd__' + sanitizeForSheetName(c));
  const rndData = await getSheetsThatExist(sheetNames);
  const rowsByCompany = {};
  companyNames.forEach((c, i) => {
    const vals = rndData[sheetNames[i]];
    rowsByCompany[c] = (vals && vals.length > 1) ? toObjects(vals, 'auto') : [];
  });

  // repair 2: shortlisted students not yet carried into the next round / the selected list
  const selected = toObjects(selVals);
  for (const c of companyNames) {
    const rounds = allRounds.filter(r => normalizeStr(r.Company_Name) === c);
    if (needsForward(rounds, rowsByCompany[c], selected, c)) throw new Error('shortlisted students need carrying forward (Apps Script does this)');
  }

  const byKey = {};
  assignments.forEach(a => {
    const company = normalizeStr(a.Company_Name);
    const round = normalizeStr(a.Round_Name);
    const key = company + '||' + round;
    if (!byKey[key]) byKey[key] = { Company_Name: company, Round_Name: round, Round_Type: normalizeStr(a.Round_Type) || round, volunteers: [] };
    const label = a.Volunteer_Name || a.Volunteer_Mobile;
    byKey[key].volunteers.push(a.Role === 'Admin' ? label + ' (Admin)' : label);
  });
  const result = Object.keys(byKey).map(key => {
    const info = byKey[key];
    if (normalizeStr(info.Round_Name).toUpperCase() === 'ATTENDANCE') {
      const counts = { Appeared: 0, Shortlisted: 0, Rejected: 0, Selected: 0, Absent: 0, Pending: 0 };
      return Object.assign({ total: 0, counts: counts, students: [], isAttendance: true }, info);
    }
    const rows = (rowsByCompany[info.Company_Name] || []).filter(r => normalizeStr(r.Round_Name) === normalizeStr(info.Round_Name));
    const counts = { Appeared: 0, Shortlisted: 0, Rejected: 0, Selected: 0, Absent: 0, Pending: 0 };
    rows.forEach(r => {
      const res = normalizeStr(r.Result);
      if (res === 'Appeared') counts.Appeared++;
      else if (res === 'Shortlisted') counts.Shortlisted++;
      else if (res === 'Rejected') counts.Rejected++;
      else if (res === 'Absent') counts.Absent++;
      else if (res === 'Selected') counts.Selected++;
      else counts.Pending++;
    });
    const students = rows.map(r => ({ Enrollment_No: r.Enrollment_No, Student_Name: r.Student_Name, Result: r.Result }));
    return Object.assign({ total: rows.length, counts: counts, students: students }, info);
  });
  const roundOrder = {}, perCompanyCount = {};
  allRounds.forEach(r => {
    const co = normalizeStr(r.Company_Name).toLowerCase();
    if (!roundOrder[co]) { roundOrder[co] = {}; perCompanyCount[co] = 0; }
    const rn = normalizeStr(r.Round_Name).toLowerCase();
    if (roundOrder[co][rn] === undefined) roundOrder[co][rn] = perCompanyCount[co]++;
  });
  result.forEach(item => {
    if (item.isAttendance) { item.Round_Order = -1; return; }
    const idx = (roundOrder[normalizeStr(item.Company_Name).toLowerCase()] || {})[normalizeStr(item.Round_Name).toLowerCase()];
    item.Round_Order = idx === undefined ? 9999 : idx;
  });
  const companyBest = {};
  result.forEach(item => { companyBest[item.Company_Name] = Math.max(companyBest[item.Company_Name] || 0, item.total); });
  result.sort((a, b) =>
    (companyBest[b.Company_Name] - companyBest[a.Company_Name]) ||
    String(a.Company_Name).localeCompare(String(b.Company_Name)) ||
    (a.Round_Order - b.Round_Order));
  return { success: true, data: result };
}

// ---------- quick company overview, global search, per-company volunteer list ----------
async function getCompanyQuickSummary(companyName) {
  const name = normalizeStr(companyName);
  const safe = sanitizeForSheetName(companyName);
  const [compVals, procVals, selVals, rndVals, regVals, master] = await Promise.all([
    getOneSheet('Companies_Master'), getOneSheet('Process_Tracking'), getOneSheet('Selected_Students'),
    getOneSheet('Rnd__' + safe), getOneSheet('Reg__' + safe), getMaster()]);
  const companies = compVals.length > 1 ? toObjects(compVals, { Date: true }, withExpected(compVals[0], COMPANIES_HEADERS)) : [];
  const company = companies.find(c => normalizeStr(c.Company_Name) === name) || null;
  if (!company) return { success: false, message: 'Company not found.' };
  {
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

  const tally = {}, everShortlisted = {};
  roundRows.forEach(rs => {
    const rn = normalizeStr(rs.Round_Name);
    if (!rn) return;
    if (!tally[rn]) tally[rn] = { appeared: 0, shortlisted: 0, rejected: 0, selected: 0, absent: 0 };
    const result = normalizeStr(rs.Result);
    if (result === 'Absent') { tally[rn].absent++; return; }
    tally[rn].appeared++;
    if (result === 'Shortlisted') tally[rn].shortlisted++;
    else if (result === 'Rejected') tally[rn].rejected++;
    else if (result === 'Selected') tally[rn].selected++;
    if (result === 'Shortlisted' || result === 'Selected') { const key = normEnroll(rs.Enrollment_No); if (key) everShortlisted[key] = true; }
  });
  rounds.forEach(r => {
    const c = tally[normalizeStr(r.Round_Name)] || { appeared: 0, shortlisted: 0, rejected: 0, selected: 0, absent: 0 };
    r.Students_Appeared = c.appeared; r.Students_Shortlisted = c.shortlisted; r.Students_Rejected = c.rejected; r.Students_Selected = c.selected; r.Students_Absent = c.absent;
  });
  const registeredRows = toObjects(regVals, 'auto');
  const registeredKeys = {}, appearedKeys = {};
  registeredRows.forEach(r => {
    const key = normEnroll(r.Enrollment_No);
    if (!key) return;
    registeredKeys[key] = true;
    if (normalizeStr(r.Attendance) === 'Present') appearedKeys[key] = true;
  });
  const selectedKeys = {};
  rawStudents.forEach(st => { const key = normEnroll(st.Enrollment_No); if (key) selectedKeys[key] = true; });
  const funnel = { registered: Object.keys(registeredKeys).length, appeared: Object.keys(appearedKeys).length,
    shortlisted: Object.keys(everShortlisted).length, selected: Object.keys(selectedKeys).length };

  const registeredBranchCounts = {}, seenRegistered = {};
  registeredRows.forEach(r => {
    const key = normEnroll(r.Enrollment_No);
    if (!key || seenRegistered[key]) return;
    seenRegistered[key] = true;
    const m = master.map[key];
    const branch = normalizeStr(r.Branch) || normalizeStr(m && m.Branch) || 'Unspecified';
    registeredBranchCounts[branch] = (registeredBranchCounts[branch] || 0) + 1;
  });
  const selectedBranchCounts = {}, seenSelected = {};
  rawStudents.forEach(st => {
    const key = normEnroll(st.Enrollment_No);
    if (key) { if (seenSelected[key]) return; seenSelected[key] = true; }
    const m = key ? master.map[key] : null;
    const branch = normalizeStr(st.Branch) || normalizeStr(m && m.Branch) || 'Unspecified';
    selectedBranchCounts[branch] = (selectedBranchCounts[branch] || 0) + 1;
  });
  const toSortedArray = obj => Object.keys(obj).sort().map(b => ({ branch: b, count: obj[b] }));
  return { success: true, company: company, funnel: funnel, rounds: rounds,
    registeredByBranch: toSortedArray(registeredBranchCounts), selectedByBranch: toSortedArray(selectedBranchCounts) };
}

async function globalSearch(query) {
  const q = normalizeStr(query).toLowerCase();
  if (q.length < 2) return { success: true, companies: [], students: [] };
  const RESULT_CAP = 8;
  const [compVals, selVals, master] = await Promise.all([getOneSheet('Companies_Master'), getOneSheet('Selected_Students'), getMaster()]);
  const companies = (compVals.length > 1 ? toObjects(compVals, { Date: true }, withExpected(compVals[0], COMPANIES_HEADERS)) : [])
    .filter(c => normalizeStr(c.Company_Name).toLowerCase().includes(q) || normalizeStr(c.POC_Name).toLowerCase().includes(q))
    .slice(0, RESULT_CAP)
    .map(c => ({ Company_Name: c.Company_Name, Status: c.Status, Current_Stage: c.Current_Stage }));
  const placedMatches = selectedStudentObjects(selVals)
    .filter(s => normalizeStr(s.Student_Name).toLowerCase().includes(q) || normalizeStr(s.Enrollment_No).toLowerCase().includes(q))
    .map(s => ({ Student_Name: s.Student_Name, Enrollment_No: s.Enrollment_No, Branch: s.Branch, Company_Name: s.Company_Name, Placed: true }));
  const placedKeys = {};
  placedMatches.forEach(s => { placedKeys[normEnroll(s.Enrollment_No)] = true; });
  const masterMatches = master.rows
    .filter(s => !placedKeys[normEnroll(s.Enrollment)] &&
      (normalizeStr(s.Name).toLowerCase().includes(q) || normalizeStr(s.Enrollment).toLowerCase().includes(q)))
    .map(s => ({ Student_Name: s.Name, Enrollment_No: s.Enrollment, Branch: s.Branch, Company_Name: '', Placed: false }));
  return { success: true, companies: companies, students: placedMatches.concat(masterMatches).slice(0, RESULT_CAP) };
}

async function getRoundVolunteerAssignments(companyName) {
  const [volVals, compVals, procVals] = await Promise.all([getOneSheet('Round_Volunteers'), getOneSheet('Companies_Master'), getOneSheet('Process_Tracking')]);
  const companies = compVals.length > 1 ? toObjects(compVals, { Date: true }, withExpected(compVals[0], COMPANIES_HEADERS)) : [];
  const vols = volVals.length > 1 ? toObjects(volVals, 'auto', withExpected(volVals[0], ROUND_VOLUNTEERS_HEADERS)) : [];
  const liveNames = {};
  companies.forEach(c => { liveNames[c.Company_Name] = true; });
  if (vols.some(a => { const n = String(a.Company_Name == null ? '' : a.Company_Name); return n && !liveNames[n]; })) {
    throw new Error('a volunteer row names an unknown company (Apps Script repairs this)');
  }
  const allRounds = procVals.length > 1 ? toObjects(procVals, null, withExpected(procVals[0], ROUNDS_HEADERS)) : [];
  if (adminRoundSyncWouldAdd(vols, allRounds, companyName)) throw new Error('admin rounds need syncing (Apps Script does this)');
  const rows = vols.filter(r => normalizeStr(r.Company_Name) === normalizeStr(companyName));
  rows.forEach(r => {
    if (!r.Round_Type) r.Round_Type = r.Round_Name;
    if (!r.Role) r.Role = 'Volunteer';
    r.Access_Status = normalizeAccessStatus(r.Access_Status);
  });
  return { success: true, data: rows };
}

// ---------- Branches screen: the three student lists (selected / no offers / full roster) ----------
function normalizedSetOf(arr) {
  const set = {};
  (arr || []).forEach(v => { const n = normalizeStr(v); if (n) set[n] = true; });
  return set;
}
function studentMeetsCriteria(student, criteria, engSet, mcaSet) {
  if (!criteria) return true;
  const check = (rawValue, rawMin) => {
    if (rawMin === '' || rawMin === null || rawMin === undefined) return true;
    const min = parseFloat(rawMin);
    if (isNaN(min)) return true;
    const val = parseFloat(rawValue);
    return !isNaN(val) && val >= min;
  };
  if (!check(student['10th_Percent'], criteria.min10th)) return false;
  if (!check(student['12th_Percent'], criteria.min12th)) return false;
  const branchKey = normalizeStr(student.Branch);
  if (engSet[branchKey] && !check(student.BTech_CGPA, criteria.minCgpa)) return false;
  if (mcaSet[branchKey] && !check(student.Grad_Marks, criteria.minGrad)) return false;
  return true;
}
async function branchListBase(branches, colleges, criteria) {
  const bc = BRANCH_OPTIONS_BY_COURSE;   // the same lists, kept in this file so this screen never depends on regconst.js
  const engSet = normalizedSetOf(bc['Engineering'].concat(bc['Pharmacy']));   // B.Pharma is also asked the CGPA
  const mcaSet = normalizedSetOf(bc['MCA'].concat(bc['Management']));
  const bSet = normalizedSetOf(branches), cSet = normalizedSetOf(colleges);
  const [master, selVals] = await Promise.all([getMaster(), getOneSheet('Selected_Students')]);
  const selected = selectedStudentObjects(selVals);
  const index = {};
  selected.forEach(sx => {
    const key = normEnroll(sx.Enrollment_No);
    if (!key) return;
    if (!index[key]) index[key] = { count: 0, companies: [] };
    index[key].count += 1;
    index[key].companies.push(normalizeStr(sx.Company_Name));
  });
  const enrich = r => {
    const sel = index[normEnroll(r.Enrollment)] || { count: 0, companies: [] };
    r.Total_Offers = sel.count;
    r.Companies_Selected = sel.companies.join(', ');
    r.Placement_Status = sel.count === 0 ? 'Not Placed' : (sel.count === 1 ? 'Placed' : 'Placed (Multiple Offers)');
    return r;
  };
  return { bSet, cSet, hasB: Object.keys(bSet).length > 0, hasC: Object.keys(cSet).length > 0, master, selected,
    meets: r => studentMeetsCriteria(r, criteria, engSet, mcaSet), enrich };
}
async function getBranchSelections(branches, colleges, company, criteria) {
  const b = await branchListBase(branches, colleges, criteria);
  const co = normalizeStr(company);
  const qualifying = {};
  b.selected.forEach(sx => {
    if (b.hasB && !b.bSet[normalizeStr(sx.Branch)]) return;
    if (co && normalizeStr(sx.Company_Name) !== co) return;
    const key = normEnroll(sx.Enrollment_No);
    if (key) qualifying[key] = true;
  });
  const rows = dedupeByEnrollment(b.master.rows.map(r => Object.assign({}, r)), 'Enrollment').filter(r =>
    (!b.hasC || b.cSet[normalizeStr(r.College)]) && qualifying[normEnroll(r.Enrollment)] && b.meets(r));
  const enriched = rows.map(b.enrich).filter(r => r.Total_Offers > 0);
  const totalOffers = enriched.reduce((sum, r) => sum + (r.Total_Offers || 0), 0);
  return { success: true, data: enriched, totalOffers: totalOffers };
}
async function branchMasterList(branches, colleges, criteria, keep) {
  const b = await branchListBase(branches, colleges, criteria);
  const rows = dedupeByEnrollment(b.master.rows.map(r => Object.assign({}, r)), 'Enrollment').filter(r =>
    (!b.hasB || b.bSet[normalizeStr(r.Branch)]) && (!b.hasC || b.cSet[normalizeStr(r.College)]) && b.meets(r));
  return { success: true, data: rows.map(b.enrich).filter(keep) };
}
async function getBranchNoOffers(branches, colleges, company, criteria) { return branchMasterList(branches, colleges, criteria, r => !r.Total_Offers); }
async function getBranchRoster(branches, colleges, company, criteria) { return branchMasterList(branches, colleges, criteria, () => true); }

module.exports = { getDashboardData, getCompanyList, getBranchAndCollegeLists, getRegisteredStudents, getRoundStudents, getRoundCounts, getCompanyDetails,
  getBranchViewFilters, getTopPackageStudents, getPlacementRate, getPackageAnalytics, getGlobalSelectionSummary, getAllStudentsMaster,
  getRegisteredStudentDownloadFields, getRegisteredStudentEditFields,
  getGDRollCallCounts, getGDRollCallState, getVolunteerRoundBoard, volunteerLogin, syncVolunteerRoundOnOpen,
  exportFormattedFile, getRegistrationFormForCompany, checkRegistrationEligibility,
  getAttendanceSessionStatus, verifyVolunteerMobile, getPhotoRequestForStudent, getFeedbackFormForStudent, getCurrentAttendanceToken, getVolunteerLiveOverview,
  getCompanyQuickSummary, globalSearch, getRoundVolunteerAssignments,
  getBranchSelections, getBranchNoOffers, getBranchRoster };
