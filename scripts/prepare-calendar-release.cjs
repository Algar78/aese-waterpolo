const fs=require('fs');
const bundle=JSON.parse(fs.readFileSync('calendars/general-calendar.json'));
const baseline={matches:bundle.matches.map(({tournament_id,match_id,category})=>({tournament_id,match_id,category})),venues:bundle.venues};
fs.writeFileSync('calendar_offline_bundle.gs','// Validated identity/category and venue registry; no network dependency for Clupik.\nconst AESE_OFFLINE_BUNDLE = '+JSON.stringify(baseline)+';\n');
