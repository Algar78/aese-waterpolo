// Explicit manual audit import, never part of the scheduled exporter.
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const file='data/actawp_matches.json';
const matches=JSON.parse(readFileSync(file));
const rows=readFileSync('docs/official-times-2026-10-15.csv','utf8').trim().split(/\r?\n/).slice(1).map(line=>line.split(','));
const official=new Map(rows.map(([id,utc])=>[Number(id),utc]));
if(official.size!==80 || matches.length!==80 || matches.some(m=>!official.has(m.match_id))) throw Error('Cobertura de auditoría incompleta');
const format=date=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date).replace(' ','T');
const changes=[];
for(const match of matches){
  const utc=official.get(match.match_id), date=new Date(utc), local=format(date);
  const offset=(Date.parse(local+'Z')-date.getTime())/60000;
  const start=local+'+'+String(offset/60).padStart(2,'0')+':00';
  if(match.start!==start) changes.push({identity:`${match.tournament_id}:${match.match_id}`,previous_start:match.start,start,source:match.url});
  match.start=start;
}
matches.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
const raw=JSON.stringify(matches,null,2)+'\n';
writeFileSync(file,raw);
const status=JSON.parse(readFileSync('data/actawp_export_status.json'));
status.snapshot_sha256=createHash('sha256').update(raw).digest('hex');
status.reviewed_corrections[0].direct_actawp_verification='verified_browser_2026-10-15';
status.official_times_audit={date:'2026-10-15',matches:80,source:'docs/official-times-2026-10-15.csv',method:'Visible Madrid wall clock agrees with UTC data-sort on nine official ActaWP/Clupik calendar tables'};
writeFileSync('data/actawp_export_status.json',JSON.stringify(status,null,2)+'\n');
writeFileSync('docs/official-time-corrections-2026-10-15.json',JSON.stringify(changes,null,2)+'\n');
console.log(JSON.stringify({audited:80,changed:changes.length,changes},null,2));
