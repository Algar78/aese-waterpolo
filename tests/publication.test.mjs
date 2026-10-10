import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const workflow=readFileSync(new URL('../.github/workflows/actawp-export.yml',import.meta.url),'utf8');
test('publicación con main avanzado conserva snapshot y cambios concurrentes, sin force',()=>{
  assert.ok(workflow.includes('git pull --rebase origin main'));
  assert.ok(workflow.includes('git push origin HEAD:main'));
  assert.ok(!/git push.*--force/.test(workflow));
  const dir=mkdtempSync(join(tmpdir(),'aese-publication-'));
  const git=(cwd,...args)=>{
    const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'AESE test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'AESE test',GIT_COMMITTER_EMAIL:'test@example.invalid'}});
    assert.equal(r.status,0,r.stderr);return r.stdout;
  };
  try {
    const remote=join(dir,'remote.git'),writer=join(dir,'writer'),bot=join(dir,'bot');
    git(dir,'init','--bare','--initial-branch=main',remote);git(dir,'clone',remote,writer);
    mkdirSync(join(writer,'data'));writeFileSync(join(writer,'data/snapshot.json'),'old');
    git(writer,'add','.');git(writer,'commit','-m','initial');git(writer,'push','origin','main');git(dir,'clone',remote,bot);
    writeFileSync(join(bot,'data/snapshot.json'),'new validated snapshot');git(bot,'add','data');git(bot,'commit','-m','snapshot');
    writeFileSync(join(writer,'concurrent.txt'),'legitimate concurrent work');git(writer,'add','.');git(writer,'commit','-m','other work');git(writer,'push','origin','main');
    const rejected=spawnSync('git',['push','origin','HEAD:main'],{cwd:bot,encoding:'utf8'});assert.notEqual(rejected.status,0);
    git(bot,'pull','--rebase','origin','main');git(bot,'push','origin','HEAD:main');git(writer,'pull','--rebase','origin','main');
    assert.equal(readFileSync(join(writer,'data/snapshot.json'),'utf8'),'new validated snapshot');
    assert.equal(readFileSync(join(writer,'concurrent.txt'),'utf8'),'legitimate concurrent work');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
