import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkContext } from '../integrations/session-metadata/src/work-context.mjs';
import { WorkingDirectories } from '../mods/space-agents/model.js';
import { metadataFixture } from './helpers/session-metadata-fixtures.mjs';

function fixture({hostname='github.com',host='local',remote='git@github-personal:person/repo-a.git'}={}) {
  const calls=[];
  const execute=async(command,args,options={})=>{
    calls.push({command,args,options});
    if(command==='git') {
      const stdout=args.includes('--show-toplevel')?'/workspace/repo-a':args.includes('--show-prefix')?'':args[0]==='config'?remote
        :args.includes('--git-dir')?'/workspace/repo-a/.git\n/workspace/repo-a/.git':'feature/review';
      return {code:0,stdout,stderr:''};
    }
    if(command==='ssh'){assert.deepEqual(args,['-G','git@github-personal']);return {code:0,stdout:`hostname ${hostname}\nuser git\n`,stderr:''};}
    assert.equal(command,'gh');assert.notEqual(args[0],'auth','repository detection must not change authentication');
    const value=args[0]==='repo'?{url:'https://github.com/person/repo-a',name:'repo-a',owner:{login:'person'},parent:null}
      :[{number:12,state:'OPEN',url:'https://github.com/person/repo-a/pull/12',title:'Review',headRefName:'feature/review'}];
    return {code:0,stdout:JSON.stringify(value),stderr:''};
  };
  return {calls,execute,run:async(on,...args)=>{assert.equal(on,host);return execute(...args);}};
}

test('session repository detection resolves an SSH alias through configuration on its execution host',async()=>{
  const {observation}=metadataFixture(),f=fixture({host:'devbox'});
  const result=await resolveWorkContext({...observation,session:{...observation.session,host:'devbox'},kind:'tool',payload:{cwd:'/workspace/repo-a',command:'git commit -m change'}},null,f.run);
  assert.equal(result.state,'resolved');assert.deepEqual(result.context.repo,{host:'github.com',owner:'person',name:'repo-a'});
  assert.equal(result.context.activePrUrl,'https://github.com/person/repo-a/pull/12');
  assert.ok(f.calls.some(call=>call.command==='ssh'));
});

test('unbound card checkout detection recognizes a configured GitHub SSH alias',async()=>{
  const f=fixture(),directories=new WorkingDirectories();
  const result=await directories.refresh({cwd:'/workspace/repo-a',machine:'devbox'},f.execute,1000);
  assert.equal(result?.repo.owner,'person');assert.equal(result.branch,'feature/review');assert.equal(result.checkoutType,'checkout');
  assert.equal(f.calls.find(call=>call.command==='ssh').options.on,'devbox');
});

test('a GitHub-looking alias is not trusted when SSH resolves it to another host',async()=>{
  const {observation}=metadataFixture(),f=fixture({hostname:'not-github.example'});
  const result=await resolveWorkContext({...observation,kind:'tool',payload:{cwd:'/workspace/repo-a'}},null,f.run);
  assert.equal(result.state,'unavailable');assert.equal(f.calls.some(call=>call.command==='gh'),false);
});

test('malformed alias targets cannot become SSH options or executable commands',async()=>{
  const {observation}=metadataFixture();
  for(const remote of ['git@-Fbad:person/repo-a.git','git@github-personal;evil:person/repo-a.git','git@github-personal\n:person/repo-a.git']) {
    const f=fixture({remote}),result=await resolveWorkContext({...observation,kind:'tool',payload:{cwd:'/workspace/repo-a'}},null,f.run);
    assert.equal(result.state,'unavailable');assert.equal(f.calls.some(call=>call.command==='ssh'||call.command==='gh'),false);
  }
});
