const AESE_RELEASE = 'pr9-reliability-2026-10-17-v1';

// Read-only evidence against the original identities, independent of Pages.
function auditAESECalendar() {
  const calendar=CalendarApp.getCalendarById(ACTAWP_CALENDAR_ID);
  const events=calendar.getEvents(new Date('2020-01-01T00:00:00Z'),new Date('2036-01-01T00:00:00Z'));
  const missing=[],duplicates=[],matched=[];
  for(const match of AESE_OFFLINE_BUNDLE.matches) {
    // Old-format markers need a canonical source URL to verify ownership.
    match.url='https://actawp.natacio.cat/ca/tournament/'+match.tournament_id+'/match/'+match.match_id+'/results';
    const owned=events.filter(e=>ownsActaWPEvent_(e,match));
    if(!owned.length) missing.push(actaWPIdentity_(match));
    if(owned.length>1) duplicates.push(actaWPIdentity_(match));
    owned.forEach(e=>matched.push({identity:actaWPIdentity_(match),event:e.getId(),start:e.getStartTime().toISOString()}));
  }
  const props=PropertiesService.getScriptProperties();
  const result={release:AESE_RELEASE,at:new Date().toISOString(),originals:AESE_OFFLINE_BUNDLE.matches.length,
    totalEvents:events.length,matched:matched.length,missing,duplicates,
    clupikSuccess:props.getProperty('AESE_CLUPIK_LAST_SUCCESS'),fullSync:props.getProperty(ACTAWP_SYNC_PROPERTY),
    cursor:props.getProperty('ACTAWP_BATCH_CURSOR_V1'),lastError:props.getProperty('AESE_LAST_ERROR'),events:matched};
  const ownedIds=new Set(matched.map(m=>m.event));
  result.extras=events.filter(e=>!ownedIds.has(e.getId())).map(e=>({event:e.getId(),title:e.getTitle(),start:e.getStartTime().toISOString(),description:e.getDescription()}));
  result.legacyDuplicates=result.extras.filter(e=>AESE_OFFLINE_BUNDLE.matches.some(m=>
    (e.description||'').includes('CLUPIK_MATCH_ID:'+m.match_id+'\n') &&
    (e.description||'').includes('/tournament/'+m.tournament_id+'/match/'+m.match_id+'/results'))).map(e=>e.event);
  result.controls=matched.filter(m=>['1339803:145573561','1339808:145574486','1339810:145608988'].includes(m.identity));
  const summary=Object.assign({},result);delete summary.events;
  console.log(JSON.stringify(summary));
  return result;
}

function readAESEReleaseEvidence() {
  const props=PropertiesService.getScriptProperties();
  console.log(JSON.stringify({release:AESE_RELEASE,count:props.getProperty('AESE_VERIFY_COUNT'),
    cycles:Array.from({length:12},(_,i)=>props.getProperty('AESE_VERIFY_'+i)),
    clupikSuccess:props.getProperty('AESE_CLUPIK_LAST_SUCCESS'),fullSync:props.getProperty(ACTAWP_SYNC_PROPERTY),
    cursor:props.getProperty('ACTAWP_BATCH_CURSOR_V1'),
    triggers:ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction())}));
  auditAESECalendar();
}

function startAESEReleaseVerification() {
  const props=PropertiesService.getScriptProperties();
  props.setProperty('AESE_VERIFY_COUNT','0');
  if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='verifyAESEReleaseCycle'))
    ScriptApp.newTrigger('verifyAESEReleaseCycle').timeBased().everyMinutes(1).create();
  console.log('Twelve automatic verification cycles scheduled, one complete reconciliation pass');
}

function verifyAESEReleaseCycle() {
  // Slow Calendar calls may overlap minute triggers. Serialize probes separately
  // from the script lock used by the real reconciliation functions.
  const probeLock=LockService.getUserLock();
  if(!probeLock.tryLock(1000)) { console.log('Verification already running; skipped');return; }
  const props=PropertiesService.getScriptProperties();
  const count=Number(props.getProperty('AESE_VERIFY_COUNT')||0);
  try {
    runAESECalendarSync();
    const result=auditAESECalendar();
    props.setProperty('AESE_VERIFY_'+count,JSON.stringify({release:result.release,at:result.at,matched:result.matched,missing:result.missing,duplicates:result.duplicates,legacyDuplicates:result.legacyDuplicates,error:result.lastError}));
    if(result.missing.length||result.duplicates.length||result.legacyDuplicates.length) throw Error('Original event audit failed');
  } finally {
    props.setProperty('AESE_VERIFY_COUNT',String(count+1));
    if(count>=11) ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='verifyAESEReleaseCycle').forEach(t=>ScriptApp.deleteTrigger(t));
    probeLock.releaseLock();
  }
}

function verifyClupikWithoutRemoteSource() {
  const original=fetchActaWPJSON_;
  let remoteRequests=0;
  fetchActaWPJSON_=function(){remoteRequests++;throw Error('Injected remote outage for verification');};
  try {
    const result=procesarPartidosAESE(); // Real Gmail, Calendar and script properties.
    if(result.status!=='complete'||remoteRequests) throw Error('Clupik depends on remote source');
    console.log(JSON.stringify({release:AESE_RELEASE,test:'Clupik remote outage',status:result.status,remoteRequests}));
  } finally {fetchActaWPJSON_=original;}
}

function previewAESELegacyDuplicates() { return repairAESELegacyDuplicates_(false); }
function repairAESELegacyDuplicates() { return repairAESELegacyDuplicates_(true); }
function repairAESELegacyDuplicates_(apply) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000)) throw Error('Calendar busy; retry cleanup later');
  try {
    const calendar=CalendarApp.getCalendarById(ACTAWP_CALENDAR_ID);
    const targets=[
      ['621guj4p2e4c3e2b0bq1elmf84@google.com','1339806:145574474','2027-09-04T18:45:00.000Z'],
      ['304s6an7o8f8qrlmcgq2nhmhkg@google.com','1339811:145573790','2028-01-10T09:30:00.000Z'],
      ['haphdupatq26r496s57h9l9lic@google.com','1339803:145573552','2028-07-10T12:30:00.000Z'],
      ['4hd19fus4qcs40947k0240p8n8@google.com','1339806:145574389','2026-03-10T16:15:00.000Z']
    ];
    const events=calendar.getEvents(new Date('2020-01-01T00:00:00Z'),new Date('2036-01-01T00:00:00Z'));
    const plan=[];
    for(const [eventId,identity,expectedStart] of targets) {
      const duplicate=events.find(e=>e.getId()===eventId);
      if(!duplicate) continue; // Retry after partial cleanup is idempotent.
      const [tournament_id,match_id]=identity.split(':').map(Number);
      const match={tournament_id,match_id,url:'https://actawp.natacio.cat/ca/tournament/'+tournament_id+'/match/'+match_id+'/results'};
      const originals=events.filter(e=>ownsActaWPEvent_(e,match));
      const description=duplicate.getDescription()||'';
      if(originals.length!==1 || originals[0].getId()===eventId ||
        duplicate.getStartTime().toISOString()!==expectedStart ||
        !description.includes('CLUPIK_MATCH_ID:'+match_id+'\n') ||
        !description.includes('/tournament/'+tournament_id+'/match/'+match_id+'/results'))
        throw Error('Cleanup precondition failed: '+identity);
      plan.push({duplicate,backup:{identity,event:eventId,original:originals[0].getId(),title:duplicate.getTitle(),
        start:expectedStart,end:duplicate.getEndTime().toISOString(),location:duplicate.getLocation(),description}});
    }
    // Back up every candidate before the first deletion.
    const props=PropertiesService.getScriptProperties();
    if(apply) plan.forEach(p=>props.setProperty('AESE_LEGACY_BACKUP_'+p.backup.identity,JSON.stringify(p.backup)));
    console.log(JSON.stringify({apply,plan:plan.map(p=>p.backup)}));
    if(apply) plan.forEach(p=>p.duplicate.deleteEvent());
    return plan.length;
  } finally {lock.releaseLock();}
}
