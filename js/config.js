/** App constants. Change categories, OAuth client, and file names here. */
export const APP_VERSION = 'v1.1.18';  // bump this after each push
export const CUR = 'Rs ';
export const GOOGLE_CLIENT_ID = '379149446558-pk7favl7g2hj1dugkhqog4kbb56aut0r.apps.googleusercontent.com';
export const PROFILE_FILE = 'site-ledger-settings.json';
export const CSV_FILE = 'site-ledger.csv';
export const DB_NAME = 'siteledger';
export const TOKEN_KEY = 'siteledger.oauth';
export const STORES = ['funds', 'budget', 'actions', 'sellers', 'purchases', 'meta'];
export const LOGIN_SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.file';
export const CATEGORIES = [
  'Foundation', 'Structure / Masonry', 'Roofing', 'Electrical', 'Plumbing',
  'Tiles / Flooring', 'Doors / Windows', 'Paint / Finishing', 'Kitchen',
  'Bathroom', 'Labour', 'Permits / Fees', 'Other'
];
export const PROVIDER_DEFAULTS = {openai: 'gpt-4o', qwen: 'qwen-vl-max', deepseek: 'deepseek-chat'};
export const TITLES = {
  funds: ['Add funds', 'Edit funds'],
  budget: ['Add budget', 'Edit budget'],
  actions: ['Add task', 'Edit task'],
  sellers: ['Add seller', 'Edit seller'],
  purchases: ['Add purchase', 'Edit purchase']
};
export const CHIP = {
  pending: ['pending', 'Pending'], progress: ['progress', 'In progress'], done: ['done', 'Done'],
  shortlisted: ['pending', 'Shortlisted'], contacted: ['progress', 'Contacted'],
  selected: ['done', 'Selected'], rejected: ['pending', 'Rejected']
};
export const OCR_PROMPT = 'You are a receipt/invoice parser for a construction project in a rupee currency. Read EVERY visible line on the bill. Reply ONLY with strict JSON, no markdown, no prose. Schema: {"seller":string,"date":"YYYY-MM-DD","receipt":string,"summary":string,"categories":string[],"total":number,"lines":[{"item":string,"qty":number|string,"rate":number,"amount":number,"category":string}]}. Rules: "seller" = shop/company name at the top. "date" = bill date as YYYY-MM-DD (not today unless printed). "receipt" = invoice/bill/receipt number. "summary" = a short human label, 6–12 words, like "PVC pipes, elbows and insulation tape" — never dump raw SKUs. "lines" = every purchased item/service row, not headers, not subtotals. "qty" and "rate" if printed, else empty. "rate" = unit price. "amount" MUST equal qty × rate when both are printed — never copy the unit price into amount. EVERY line MUST include "category" = exactly one of: ' + CATEGORIES.join(', ') + '. Guess from the item name if the bill does not print a category. A single bill MAY mix categories (e.g. Electrical + Plumbing) — tag each line itself, do not leave line.category empty. ISO-RANGE / ISORANGE / rouleau / insulation tape / electrical tape / cole HTA = Electrical. PVC / CPVC / elbow / tuyaux / pyn / rifen / bend / pipe fittings = Plumbing. Glue / LA COLE near pipes = Plumbing, otherwise Electrical. "categories" = unique line categories on the bill. "total" = grand total payable (numbers only). Never invent items you cannot see. If a field is unreadable use "" or [].';
export const G_ICON = '<svg viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84A4.14 4.14 0 0 1 12 13.4v2.26h2.72c1.6-1.47 2.52-3.64 2.52-6.46z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.72-2.26c-.76.5-1.72.8-3.24.8-2.49 0-4.6-1.68-5.36-3.94H.96v2.32A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.64 10.42A5.4 5.4 0 0 1 3.36 9c0-.49.08-.97.28-1.42V5.26H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.68-2.62z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 5.26L3.64 7.58C4.4 5.32 6.51 3.58 9 3.58z"/></svg>';
