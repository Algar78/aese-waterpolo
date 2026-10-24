import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const code=readFileSync(new URL('../calendar_reliability.gs',import.meta.url),'utf8');

test('manual ActaWP updates do not trigger the obsolete six-hour reconciliation alert',()=>{
  const alerts=[], checked=[];
  const properties=new Map([['AESE_CLUPIK_LAST_SUCCESS',new Date().toISOString()]]);
  const props={
    getProperty:key=>properties.get(key)||null,
    setProperty:(key,value)=>properties.set(key,value)
  };
  const context=vm.createContext({
    console:{log:()=>{}}, Date, Math, JSON, Number, Set, Map,
    PropertiesService:{getScriptProperties:()=>props},
    ScriptApp:{getProjectTriggers:()=>[{getHandlerFunction:()=> 'runAESECalendarSync'}]},
    ACTAWP_BUNDLE_URL:'https://example.invalid/bundle',
    ACTAWP_SYNC_PROPERTY:'ACTAWP_LAST_SYNC'
  });
  vm.runInContext(code,context);
  context.aeseAlert_=(type,message)=>alerts.push({type,message});
  context.aeseCheckFreshness_=(status)=>checked.push(status);
  context.fetchActaWPJSON_=url=>url.endsWith('actawp_last_attempt.json')
    ? {complete:false,attempted_at:'2026-10-18T10:35:28Z',errors:['old 429']}
    : {status:{freshness_policy:{fresh_hours:336,outdated_hours:720,automated_attempts:false}}};
  context.checkAESECalendarHealth();
  assert.deepEqual(alerts,[]);
  assert.equal(checked.length,1);
  assert.equal(checked[0].freshness_policy.automated_attempts,false);
});
