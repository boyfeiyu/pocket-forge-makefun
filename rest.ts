import { requireValue, HttpError } from './store.ts';

export function rest(store:any,method:string,path:string,q:URLSearchParams,b:any,base:string):any {
  const parts=path.replace(/^\/api\/v3\/?/,'').split('/').map(decodeURIComponent),[root,owner,name,op,arg,sub]=parts;
  const ok=(body:any,status=200,headers:any={})=>({body,status,headers});
  const page=(a:any[])=>{const n=Math.max(1,Number(q.get('per_page'))||30),p=Math.max(1,Number(q.get('page'))||1);const headers:any={};if(p*n<a.length){const u=new URL(base+path);u.search=q.toString();u.searchParams.set('page',String(p+1));headers.Link=`<${u}>; rel="next"`;}return ok(a.slice((p-1)*n,p*n),200,headers);};
  if(!root&&method==='GET')return ok({current_user_url:base+'/api/v3/user',repository_url:base+'/api/v3/repos/{owner}/{repo}'},200,{'X-OAuth-Scopes':'repo, read:org'});
  if(root==='meta'&&method==='GET')return ok({installed_version:'pocket-forge-1.0.0'});
  if(root==='user'&&owner==='repos'){if(method==='POST')return ok(store.createRepo(b),201);if(method==='GET')return page([...store.repos.values()]);}
  if(root==='user'&&!owner&&method==='GET')return ok(store.user());
  if(root!=='repos'||!owner||!name)throw new HttpError(404,'Not Found');
  const r=store.repo(owner,name);
  if(!op){if(method==='GET')return ok(r);if(method==='PATCH'){for(const key of ['description','private','default_branch','has_issues'])if(key in b)r[key]=b[key];return ok(r);}if(method==='DELETE'){store.repos.delete(name);return ok(null,204);}}
  if(op==='contents'){
    const file=parts.slice(4).join('/');if(method==='GET')return ok(store.content(r,file,q.get('ref')||undefined));
    if(method==='PUT'||method==='DELETE'){const x=store.edit(r,file,b,method==='DELETE');return ok(x.body,method==='DELETE'?200:x.status);}
  }
  if(op==='branches'&&method==='GET')return ok([...r.refs].filter(([ref]:any)=>ref.startsWith('refs/heads/')).map(([ref,sha]:any)=>({name:ref.slice(11),commit:{sha},protected:false})));
  if(op==='commits'&&method==='GET'){
    const todo=[store.tip(r,q.get('sha')||undefined)],seen=new Set(),list=[];
    while(todo.length){
      const sha=todo.shift();if(!sha||seen.has(sha))continue;seen.add(sha);
      const c=store.objects.commit(sha);
      // Git stores a terminal LF. Omit that one presentation terminator, not
      // meaningful indentation, paragraph breaks, trailing spaces or other LFs.
      list.push({sha,commit:{message:c.message.replace(/\n$/, '')},parents:c.parents.map((sha:string)=>({sha}))});
      todo.push(...c.parents);
    }
    return page(list);
  }
  if(op==='git'){
    if(arg==='refs'&&!sub&&method==='POST'){requireValue(b.ref&&store.objects.get(b.sha),422,'Invalid ref or object');if(r.refs.has(b.ref))throw new HttpError(422,'Ref exists');r.refs.set(b.ref,b.sha);return ok({ref:b.ref,object:{sha:b.sha,type:store.objects.get(b.sha).type}},201);}
    if(arg==='refs'||arg==='ref'){const ref=parts.slice(5).join('/'),full=ref.startsWith('refs/')?ref:'refs/'+ref;const sha=requireValue(r.refs.get(full));if(method==='GET')return ok({ref:full,object:{sha,type:store.objects.get(sha).type}});if(method==='DELETE'){r.refs.delete(full);return ok(null,204);}if(method==='PATCH'){requireValue(store.objects.get(b.sha),422,'Unknown object');if(!store.objects.ancestor(sha,b.sha))throw new HttpError(422,'Not a fast forward');r.refs.set(full,b.sha);return ok({ref:full,object:{sha:b.sha}});}}
  }
  if(op==='labels'){if(method==='POST'){requireValue(b.name,422,'name is required');const l={name:b.name,color:b.color||'ededed'};r.labels.set(b.name,l);return ok(l,201);}if(method==='GET')return ok([...r.labels.values()]);}
  if(op==='issues'||op==='pulls'){
    if(!arg){if(method==='POST')return ok(op==='issues'?store.issue(r,b):store.pull(r,b),201);if(method==='GET')return page(store.list(r,op,Object.fromEntries(q)));}
    const i=requireValue(r[op].get(Number(arg)));
    if(!sub){if(method==='GET')return ok(i);if(method==='PATCH'){for(const key of ['title','body','state'])if(key in b)i[key]=b[key];return ok(i);}}
    if(sub==='comments'){if(method==='POST')return ok(store.comment(i,b),201);if(method==='GET')return page(i.comments);}
    if(op==='pulls'&&sub==='files'&&method==='GET')return page(store.changes(i));
    if(op==='pulls'&&sub==='merge'&&method==='PUT')return ok(store.merge(i,b));
  }
  throw new HttpError(404,'Not Found');
}
