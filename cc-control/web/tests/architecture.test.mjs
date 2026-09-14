import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
const root=resolve(import.meta.dirname,'../src');
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(resolve(dir,entry.name)):/\.(jsx?|css)$/.test(entry.name)?[resolve(dir,entry.name)]:[]);}
test('shared dependencies point downward and pages do not import other pages',()=>{
  for(const file of files(root)){
    const path=relative(root,file),source=readFileSync(file,'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){
      if(!match[1].startsWith('.'))continue;
      const target=relative(root,resolve(dirname(file),match[1]));
      if(path.startsWith('shared/'))assert.ok(target.startsWith('shared/')||target.startsWith('../../docs/design/'),`${path} imports ${target}`);
      if(path.startsWith('shared/components/ui/'))assert.ok(!target.startsWith('shared/components/business/')&&!target.startsWith('shared/api/'),`${path} imports business code`);
      if(path.startsWith('pages/')&&target.startsWith('pages/'))assert.equal(target.split('/')[1],path.split('/')[1],`${path} imports another page`);
    }
  }
});
