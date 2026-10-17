const AESE_RELEASE = 'pr9-reliability-2026-10-17-v1';

// Read-only evidence against the original identities, independent of Pages.
function auditAESECalendar() {
  const calendar=CalendarApp.getCalendarById(ACTAWP_CALENDAR_ID);
  const events=calendar.getEvents(new Date('2026-08-01T00:00:00Z'),new Date('2028-08-01T00:00:00Z'));
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
  result.controls=matched.filter(m=>['1339803:145573561','1339808:145574486','1339810:145608988'].includes(m.identity));
  const summary=Object.assign({},result);delete summary.events;
  console.log(JSON.stringify(summary));
  return result;
}

function readAESEReleaseEvidence() {
  const props=PropertiesService.getScriptProperties();
  console.log(JSON.stringify({release:AESE_RELEASE,count:props.getProperty('AESE_VERIFY_COUNT'),
    cycles:[0,1,2].map(i=>props.getProperty('AESE_VERIFY_'+i)),
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
  console.log('Three automatic verification cycles scheduled');
}

function verifyAESEReleaseCycle() {
  const props=PropertiesService.getScriptProperties();
  const count=Number(props.getProperty('AESE_VERIFY_COUNT')||0);
  try {
    runAESECalendarSync();
    const result=auditAESECalendar();
    props.setProperty('AESE_VERIFY_'+count,JSON.stringify({release:result.release,at:result.at,matched:result.matched,missing:result.missing,duplicates:result.duplicates,error:result.lastError}));
    if(result.missing.length||result.duplicates.length) throw Error('Original event audit failed');
  } finally {
    props.setProperty('AESE_VERIFY_COUNT',String(count+1));
    if(count>=2) ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='verifyAESEReleaseCycle').forEach(t=>ScriptApp.deleteTrigger(t));
  }
}
