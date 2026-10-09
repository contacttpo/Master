// Backend functions rewritten for the Sheets API. Each returns EXACTLY what the Apps Script
// version returns, so the pages need no change. Add more here one at a time; each new one is
// checked against the original at  /api/status?compare=1  before it is trusted.
const { getSheets, toObjects } = require('./google');

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

module.exports = { getDashboardData, getCompanyList };
