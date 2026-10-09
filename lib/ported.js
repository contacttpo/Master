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
  'MCA': ['MCA'],
  'Management': ['MBA-Core', 'MBA-BA', 'MBA-FT'],
  'Non Engineering Graduation': ['BA', 'B.Com.', 'BBA', 'BCA', 'B.Sc.']
};

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
  'Placed_Allowed', 'Excluded_Companies', 'Closes_At', 'Custom_Questions_JSON'];
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
  const want = normEnroll(companyName);
  const row = cfgVals.slice(1).find(r => normEnroll(r[ci]) === want);
  if (!row) return notFound;
  const obj = {};
  REG_FORM_CONFIG_HEADERS.forEach((h, i) => { obj[h] = row[i]; });
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

module.exports = { getDashboardData, getCompanyList, getBranchAndCollegeLists, getRegisteredStudents, getRoundStudents, getRoundCounts, getCompanyDetails,
  getBranchViewFilters, getTopPackageStudents, getPlacementRate, getPackageAnalytics, getGlobalSelectionSummary, getAllStudentsMaster,
  getRegisteredStudentDownloadFields, getRegisteredStudentEditFields };
