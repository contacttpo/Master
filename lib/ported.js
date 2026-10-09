// Backend functions rewritten for the Sheets API. Each returns EXACTLY what the Apps Script
// version returns, so the pages need no change. Add more here one at a time; each new one is
// checked against the original at  /api/status?compare=1  before it is trusted.
const { getSheets, getOneSheet, toObjects } = require('./google');

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
  const rows = toObjects(await getOneSheet('Students_Master'));
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

module.exports = { getDashboardData, getCompanyList, getBranchAndCollegeLists, getRegisteredStudents, getRoundStudents };
