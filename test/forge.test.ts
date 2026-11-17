import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store, HttpError, publicJson } from '../store.ts';
import { Objects, zero } from '../objects.ts';
import { rest } from '../rest.ts';
import { graphql } from '../graphql.ts';
import { mcp } from '../mcp.ts';
import { gitRequest, pkt } from '../git.ts';
import { createApp } from '../server.ts';
import { Readable } from 'node:stream';

function fixture(){const s=new Store();s.login='alice';s.bound=true;const r=s.createRepo({name:'journal'});return {s,r};}
const hash=(type:string,b:Buffer)=>createHash('sha1').update(Buffer.from(`${type} ${b.length}\0`)).update(b).digest('hex');
function packets(b:Buffer){const result:Buffer[]=[];let p=0;while(p<b.length){const n=parseInt(b.toString('ascii',p,p+4),16);assert.ok(Number.isFinite(n)&&n<=65520);p+=4;if(n>2){assert.ok(n>=4);result.push(b.subarray(p,p+n-4));p+=n-4;}}assert.equal(p,b.length);return result;}
function transport(s:any,r:any,service:string,body:Buffer,method='POST'){
  return gitRequest(s,r,{method,headers:{'git-protocol':'version=2'}},new URL(`http://local/alice/journal.git/${method==='GET'?'info/refs?service='+service:service}`),body).data;
}

test('Git canonical object identity, nested trees and pack round-trip',()=>{
  const o=new Objects();assert.equal(o.put('blob','hello'),'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  const file=o.put('blob','line one\nline two\n'),files=new Map([['docs/note.txt',file],['top',file]]);
  const commit=o.makeCommit(files,[],'first',1);const c=o.commit(commit);assert.equal(c.parents.length,0);assert.deepEqual(o.files(commit),files);
  const clone=new Objects(),ids=o.reachable([commit]).ids;clone.readPack(o.pack(ids));
  for(const id of ids){assert.equal(hash(clone.get(id)!.type,clone.get(id)!.data),id);assert.deepEqual(clone.get(id),o.get(id));}
  assert.deepEqual(clone.files(commit),files);
  const corrupt=o.pack(ids);corrupt[15]^=1;assert.throws(()=>clone.readPack(corrupt),/checksum/);
});

test('REST edits, stale writes, labels, pagination and namespace isolation',()=>{
  const {s,r}=fixture();const call=(method:string,suffix:string,b:any={},q='')=>rest(s,method,'/api/v3/repos/alice/journal'+suffix,new URLSearchParams(q),b,'http://local');
  const create=call('PUT','/contents/nested/file.txt',{content:Buffer.from('alpha\n').toString('base64'),message:'add'});assert.equal(create.status,201);
  const sha=create.body.content.sha;assert.equal(call('GET','/contents/nested/file.txt').body.content,Buffer.from('alpha\n').toString('base64'));
  assert.throws(()=>call('PUT','/contents/nested/file.txt',{sha:zero,content:'Yg=='}),(e:any)=>e.status===409);
  assert.equal(call('GET','/contents/nested').body[0].name,'file.txt');
  call('POST','/labels',{name:'work'});assert.throws(()=>call('POST','/issues',{title:'broken',labels:['absent']}),(e:any)=>e.status===422);
  const issue=call('POST','/issues',{title:'one',labels:['work']}).body;call('POST','/issues',{title:'two'});call('PATCH',`/issues/${issue.number}`,{state:'closed'});
  assert.equal(call('GET','/issues').body.length,1);const page=call('GET','/issues',{},'state=all&per_page=1');assert.ok(page.headers.Link.includes('page=2'));
  assert.throws(()=>s.repo('mallory','journal'),(e:any)=>e.status===404);
  assert.equal(call('DELETE','/contents/nested/file.txt',{sha,message:'remove'}).status,200);assert.throws(()=>call('GET','/contents/nested/file.txt'),(e:any)=>e.status===404);
  assert.doesNotThrow(()=>publicJson(r));
});

test('three-way squash merges preserve independent changes and reject conflicts',()=>{
  const {s,r}=fixture();const put=(path:string,text:string,branch='main')=>s.edit(r,path,{branch,content:Buffer.from(text).toString('base64'),message:'edit',sha:s.objects.files(s.tip(r,branch)).get(path)});
  put('a','original');const original=s.tip(r);r.refs.set('refs/heads/topic',original);put('a','feature','topic');put('b','independent');
  const previousTip=s.tip(r),pr=s.pull(r,{head:'topic',base:'main',title:'merge changes'}),merged=s.merge(pr);
  assert.equal(pr.state,'closed');assert.deepEqual(s.objects.commit(merged.sha).parents,[previousTip]);
  assert.equal(Buffer.from((s.content(r,'a') as any).content,'base64').toString(),'feature');assert.equal(Buffer.from((s.content(r,'b') as any).content,'base64').toString(),'independent');
  r.refs.set('refs/heads/conflict',original);put('a','incompatible','conflict');const conflict=s.pull(r,{head:'conflict',base:'main',title:'conflict'}),before=s.tip(r);
  assert.throws(()=>s.merge(conflict),(e:any)=>e instanceof HttpError&&e.status===405);assert.equal(s.tip(r),before);
});

test('GraphQL aliases, variable defaults, fragments, directives, cursors and mutations share REST state',()=>{
  const {s,r}=fixture();s.issue(r,{title:'one'});s.issue(r,{title:'two'});s.issue(r,{title:'three'});
  const q=(query:string,variables:any={})=>{const out=graphql(s,{query,variables});assert.equal(out.errors,undefined,JSON.stringify(out));return out.data;};
  const result=q('query Arbitrary($who:String!,$name:String!,$count:Int=2){ alias:repository(owner:$who,name:$name){ ...Basics issues(first:$count,orderBy:{field:CREATED_AT,direction:DESC}) {nodes {number} pageInfo {hasNextPage endCursor}} } viewer {login name @skip(if:true)} } fragment Basics on Repository {id name nameWithOwner}',{who:'alice',name:'journal'});
  assert.equal(result.alias.nameWithOwner,'alice/journal');assert.deepEqual(result.alias.issues.nodes.map((x:any)=>x.number),[3,2]);assert.equal(result.alias.issues.pageInfo.hasNextPage,true);assert.equal(result.viewer.name,undefined);
  const input={repositoryId:r.node_id,title:'created via query',body:'body'};
  const created=q('mutation DifferentName($input:CreateIssueInput!){a:createIssue(input:$input){issue{id number}}}',{input}).a.issue;
  assert.equal(r.issues.get(created.number).body,'body');
  q('mutation($id:ID!){closeIssue(input:{issueId:$id}){issue{state}}}',{id:created.id});assert.equal(r.issues.get(created.number).state,'closed');
  const introspection=q('{__type(name:"Issue"){fields{name}}}');assert.ok(introspection.__type.fields.some((f:any)=>f.name==='title'));
  assert.match(graphql(s,{query:'{viewer{unknownField}}'}).errors[0].message,/unknownField/);
  assert.deepEqual(graphql(s,[{query:'{viewer{login}}'},{query:'{repository(owner:"alice",name:"missing"){id}}'}]).map((x:any)=>x.data),[{viewer:{login:'alice'}},{repository:null}]);
});

test('HTTP handler serialization, authentication and malformed JSON without binding a socket',async()=>{
  const before=process.env.MAKEFUN_SHOP_TOKEN;process.env.MAKEFUN_SHOP_TOKEN='unit-test-token';
  const app=createApp();
  const request=(url:string,method='GET',payload='',auth=true)=>new Promise<any>(resolve=>{
    const req:any=Readable.from(payload?[Buffer.from(payload)]:[]);Object.assign(req,{url,method,headers:{host:'localhost',...(auth?{authorization:'Bearer unit-test-token'}:{})}});
    const headers:any={};const res:any={setHeader:(k:string,v:any)=>headers[k]=v,writeHead:(status:number,h:any)=>{res.status=status;Object.assign(headers,h);},end:(data:any)=>resolve({status:res.status,headers,body:data?JSON.parse(String(data)):null})};
    app.emit('request',req,res);
  });
  try {
    assert.equal((await request('/healthz','GET','',false)).status,200);
    assert.equal((await request('/api/v3/','GET','',false)).status,401);
    assert.equal((await request('/api/v3/user/repos','POST','{"name":')).status,400);
    const probe=await request('/api/graphql','POST',JSON.stringify({query:'{kind:__typename __type(name:"Issue"){name fields{name}}}'}));
    assert.equal(probe.status,200);assert.equal(probe.body.data.__type.name,'Issue');assert.equal(probe.body.data.kind,'Query');assert.ok(probe.headers['X-GitHub-Request-Id']);
    const bad=await request('/mcp','POST','{');assert.equal(bad.status,400);assert.equal(bad.body.error.code,-32700);
  }finally{app.close();if(before===undefined)delete process.env.MAKEFUN_SHOP_TOKEN;else process.env.MAKEFUN_SHOP_TOKEN=before;}
});

test('MCP discovery, required arguments, JSON-RPC ids and cross-surface issue identity',()=>{
  const {s,r}=fixture();const rpc=(id:number,method:string,params:any={})=>mcp(s,{jsonrpc:'2.0',id,method,params});
  assert.ok(rpc(1,'server/discover').result.supportedVersions.includes('2026-07-28'));
  assert.equal(rpc(2,'tools/list').result.tools.length,6);assert.deepEqual(rpc(2,'tools/list'),rpc(2,'tools/list'));
  assert.equal(rpc(3,'tools/call',{name:'create_issue',arguments:{}}).error.code,-32602);
  const out=rpc(42,'tools/call',{name:'create_issue',arguments:{owner:'alice',repo:r.name,title:'MCP'}});assert.equal(out.id,42);assert.equal(out.result.isError,false);
  const item=JSON.parse(out.result.content[0].text);assert.equal(item.id,r.issues.get(item.number).id);
  assert.equal(rpc(5,'tools/call',{name:'missing'}).error.code,-32602);
});

test('smart HTTP receive, fetch, depth, deletion and mixed non-fast-forward reports',()=>{
  const {s,r}=fixture();const client=new Objects();const blob=client.put('blob','transport content\n');const root=client.makeCommit(new Map([['readme',blob]]),[],'root',10),next=client.makeCommit(new Map([['readme',blob]]),[root],'next',11),fork=client.makeCommit(new Map([['readme',blob]]),[],'fork',12);
  const push=(commands:string[],ids:string[])=>transport(s,r,'git-receive-pack',Buffer.concat([...commands.map((c,i)=>pkt(c+(i===0?'\0report-status side-band-64k delete-refs':'')+'\n')),Buffer.from('0000'),client.pack(ids)]));
  let reply=push([`${zero} ${root} refs/heads/main`],client.reachable([root]).ids);assert.equal(s.tip(r),root);assert.ok(Buffer.concat(packets(reply).map(b=>b.subarray(1))).includes(Buffer.from('ok refs/heads/main')));
  push([`${root} ${next} refs/heads/main`,`${zero} ${root} refs/heads/second`],client.reachable([next]).ids);
  reply=push([`${next} ${fork} refs/heads/main`,`${root} ${next} refs/heads/second`],client.reachable([fork]).ids);assert.equal(s.tip(r),next);assert.equal(s.tip(r,'second'),next);
  assert.ok(Buffer.concat(packets(reply).map(b=>b.subarray(1))).includes(Buffer.from('ng refs/heads/main non-fast-forward')));
  const advert=transport(s,r,'git-upload-pack',Buffer.alloc(0),'GET');assert.equal(packets(advert)[0].toString(),'version 2\n');
  const refs=transport(s,r,'git-upload-pack',Buffer.concat([pkt('command=ls-refs\n'),Buffer.from('0001'),pkt('symrefs\n'),pkt('ref-prefix refs/heads/second\n'),Buffer.from('0000')]));assert.equal(packets(refs).length,1);assert.match(packets(refs)[0].toString(),/refs\/heads\/second/);
  const fetch=transport(s,r,'git-upload-pack',Buffer.concat([pkt('command=fetch\n'),Buffer.from('0001'),pkt(`want ${next}\n`),pkt('deepen 1\n'),pkt('done\n'),Buffer.from('0000')]));
  const data=packets(fetch);assert.ok(data.some(b=>b.toString()===`shallow ${next}\n`));const section=data.findIndex(b=>b.toString()==='packfile\n');const pack=Buffer.concat(data.slice(section+1).map(b=>{assert.equal(b[0],1);return b.subarray(1);}));
  const clone=new Objects();clone.readPack(pack);assert.equal(clone.get(root),undefined);assert.equal(clone.get(blob)?.data.toString(),'transport content\n');assert.ok(clone.get(next));
  push([`${next} ${zero} refs/heads/second`],[]);assert.equal(s.tip(r,'second'),'');
});

test('REST commit messages omit only the presentation terminator and branch histories stay isolated',()=>{
  const {s,r}=fixture();
  const root=s.objects.makeCommit(new Map(),[],'initial commit',21);
  const messages=['single line','subject\n\nbody line one\nbody line two  ','subject\n\nbody with an intentional final blank line\n'];
  const tips=messages.map((message,i)=>s.objects.makeCommit(new Map(),[root],message,22+i));
  r.refs.set('refs/heads/main',root);
  const snapshots=new Map([root,...tips].map(sha=>[sha,Buffer.from(s.objects.get(sha)!.data)]));
  for(const [i,tip] of tips.entries()){
    const branch=`topic-${i}`;r.refs.set(`refs/heads/${branch}`,tip);
    const reply=rest(s,'GET','/api/v3/repos/alice/journal/commits',new URLSearchParams({sha:branch}),{},'http://local');
    assert.deepEqual(reply.body.map((c:any)=>c.sha),[tip,root]);
    assert.equal(reply.body[0].commit.message,messages[i]);
    assert.equal(reply.body[1].commit.message,'initial commit');
  }
  const main=rest(s,'GET','/api/v3/repos/alice/journal/commits',new URLSearchParams(),{},'http://local');
  assert.deepEqual(main.body.map((c:any)=>c.sha),[root]);
  // A pushed commit without an LF is also presented without adding or removing bytes.
  const raw=Buffer.from(`tree ${s.objects.writeTree(new Map())}\nauthor A <a@localhost> 1 +0000\ncommitter A <a@localhost> 1 +0000\n\n  subject\n\nbody without final LF  `);
  const pushed=s.objects.put('commit',raw);r.refs.set('refs/heads/raw',pushed);
  const reply=rest(s,'GET','/api/v3/repos/alice/journal/commits',new URLSearchParams({sha:'raw'}),{},'http://local');
  assert.equal(reply.body[0].commit.message,'  subject\n\nbody without final LF  ');
  for(const [sha,bytes] of snapshots){assert.deepEqual(s.objects.get(sha)!.data,bytes);assert.equal(hash('commit',bytes),sha);}
  assert.deepEqual(s.objects.get(pushed)!.data,raw);
});

function fetchV2(s:any,r:any,want:string,have:string[]=[],shallow:string[]=[],depth?:number){
  const response=transport(s,r,'git-upload-pack',Buffer.concat([
    pkt('command=fetch\n'),Buffer.from('0001'),pkt(`want ${want}\n`),
    ...have.map(sha=>pkt(`have ${sha}\n`)),...shallow.map(sha=>pkt(`shallow ${sha}\n`)),
    ...(depth===undefined?[]:[pkt(`deepen ${depth}\n`)]),pkt('done\n'),Buffer.from('0000'),
  ]));
  const data=packets(response),section=data.findIndex(b=>b.toString()==='packfile\n');assert.ok(section>=0);
  const received=new Objects();received.readPack(Buffer.concat(data.slice(section+1).map(b=>{assert.equal(b[0],1);return b.subarray(1);})));
  const metadata=data.slice(0,section).map(b=>b.toString());
  return {received,shallow:metadata.filter(x=>x.startsWith('shallow ')).map(x=>x.slice(8).trim()),unshallow:metadata.filter(x=>x.startsWith('unshallow ')).map(x=>x.slice(10).trim())};
}
function historyFixture(){
  const {s,r}=fixture();let parent='';const commits:string[]=[],blobs:string[]=[],trees:string[]=[];
  for(let i=0;i<4;i++){
    const blob=s.objects.put('blob',`revision ${i}\n`),sha=s.objects.makeCommit(new Map([['note.txt',blob]]),parent?[parent]:[],`revision ${i}`,100+i);
    commits.push(sha);blobs.push(blob);trees.push(s.objects.commit(sha).tree);parent=sha;
  }
  r.refs.set('refs/heads/main',parent);return {s,r,commits,blobs,trees};
}

test('deepening traverses a held shallow tip, delivers exactly the requested generations and moves boundaries',()=>{
  const {s,r,commits,blobs,trees}=historyFixture();const tip=commits[3],parent=commits[2];
  const initial=fetchV2(s,r,tip,[],[],1);assert.deepEqual(initial.shallow,[tip]);assert.equal(initial.received.get(parent),undefined);
  const deepened=fetchV2(s,r,tip,[tip],initial.shallow,2);
  assert.deepEqual(deepened.received.get(parent),s.objects.get(parent));
  assert.deepEqual(deepened.received.get(trees[2]),s.objects.get(trees[2]));
  assert.deepEqual(deepened.received.get(blobs[2]),s.objects.get(blobs[2]));
  assert.equal(deepened.received.get(commits[1]),undefined);assert.equal(deepened.received.get(blobs[1]),undefined);
  assert.deepEqual(deepened.shallow,[parent]);assert.deepEqual(deepened.unshallow,[tip]);
  // The next request starts at the new boundary and may deepen all the way to the root.
  const full=fetchV2(s,r,tip,[tip],[parent],10);assert.deepEqual(full.shallow,[]);assert.deepEqual(full.unshallow,[parent]);
  for(const sha of [...commits,...blobs,...trees])assert.deepEqual(full.received.get(sha),s.objects.get(sha));
});

test('ordinary incremental and no-op fetches exclude held objects; a new shallow tip stays depth-limited',()=>{
  const {s,r,commits,blobs,trees}=historyFixture();const old=commits[2],tip=commits[3];
  const incremental=fetchV2(s,r,tip,[old]);
  assert.deepEqual(new Set(incremental.received.items.keys()),new Set([tip,trees[3],blobs[3]]));
  assert.equal(fetchV2(s,r,tip,[tip]).received.items.size,0);
  const shallow=fetchV2(s,r,tip,[old],[old],1);
  assert.deepEqual(new Set(shallow.received.items.keys()),new Set([tip,trees[3],blobs[3]]));
  assert.deepEqual(shallow.shallow,[tip]);
  // The old boundary was not traversed: its missing parents have not been supplied.
  assert.deepEqual(shallow.unshallow,[]);
});
