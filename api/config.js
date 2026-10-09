// Gives the page your Apps Script address from a Vercel setting, so gas-shim.js never has to be edited.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ gasUrl: process.env.GAS_URL || '' });
};
