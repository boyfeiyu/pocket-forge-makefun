import { Objects } from './objects.ts';
export class HttpError extends Error { status:number; constructor(status:number,message:string){super(message);this.status=status;} }
export const requireValue=(value:any,status=404,message='Not Found')=>{if(!value)throw new HttpError(status,message);return value;};
export class Store {
  repos=new Map<string,any>(); nodes=new Map<string,any>(); objects=new Objects(); sequence=0;
  login=process.env.MAKEFUN_LOGIN || ''; bound=!!this.login;
  id(type:string,value:any){const id=++this.sequence;value.id=id;value.node_id=Buffer.from(`${type}:${id}`).toString('base64');value._type=type;this.nodes.set(value.node_id,value);return value;}
  user(){return {login:this.login||'forge',id:1,type:'User'};}
  bind(owner:string){if(!this.bound){this.login=owner;this.bound=true;for(const r of this.repos.values()){r.owner=this.user();r.full_name=`${owner}/${r.name}`;}}}
  repo(owner:string,name:string){this.bind(owner);if(owner!==this.login)throw new HttpError(404,'Not Found');return requireValue(this.repos.get(name));}
  createRepo(b:any){requireValue(typeof b.name==='string'&&b.name.length,422,'name is required');if(this.repos.has(b.name))throw new HttpError(422,'Repository already exists');
    const r=this.id('Repository',{name:b.name,full_name:`${this.user().login}/${b.name}`,owner:this.user(),private:!!b.private,description:b.description||'',default_branch:b.default_branch||'main',has_issues:true,refs:new Map(),issues:new Map(),pulls:new Map(),labels:new Map(),next:1});this.repos.set(r.name,r);return r;
  }
  tip(r:any,ref?:string){const name=ref||r.default_branch;return r.refs.get(name)||r.refs.get(`refs/heads/${name}`)||r.refs.get(`refs/tags/${name}`)||(this.objects.get(name)?name:'');}
  content(r:any,path:string,ref?:string){const files=this.objects.files(this.tip(r,ref));const sha=files.get(path);if(sha){const data=this.objects.get(sha)!.data;return {type:'file',name:path.split('/').at(-1),path,sha,size:data.length,encoding:'base64',content:data.toString('base64')};}
    const prefix=path?path.replace(/\/$/,'')+'/':'';const entries=new Map();for(const [p,s] of files){if(p.startsWith(prefix)){const part=p.slice(prefix.length).split('/')[0];entries.set(part,{name:part,path:prefix+part,type:p.slice(prefix.length).includes('/')?'dir':'file',sha:s});}}if(!entries.size)throw new HttpError(404,'Not Found');return [...entries.values()];
  }
  edit(r:any,path:string,b:any,del=false){const branch=b.branch||r.default_branch,tip=this.tip(r,branch);const files=this.objects.files(tip),old=files.get(path);if(del&&!old)throw new HttpError(404,'Not Found');if((old&&b.sha!==old)||(!old&&b.sha))throw new HttpError(409,'sha does not match');
    const sha=del?'':this.objects.put('blob',Buffer.from(b.content||'','base64'));if(del)files.delete(path);else files.set(path,sha);
    const commit=this.objects.makeCommit(files,tip?[tip]:[],b.message||'Update contents',++this.sequence);r.refs.set(`refs/heads/${branch}`,commit);
    return {status:old?200:201,body:{content:del?null:{...this.content(r,path,branch)},commit:{sha:commit}}};
  }
  issue(r:any,b:any){requireValue(typeof b.title==='string'&&b.title,422,'title is required');const labels=(b.labels||[]).map((l:any)=>requireValue(r.labels.get(typeof l==='string'?l:l.name),422,'Label does not exist'));
    const i=this.id('Issue',{number:r.next++,title:b.title,body:b.body||'',state:'open',labels,user:this.user(),comments:[],created_at:new Date(1700000000000+this.sequence*1000).toISOString(),_repo:r});r.issues.set(i.number,i);return i;
  }
  list(r:any,kind:string,q:any={}){const state=q.state||'open';let a=[...r[kind].values()].filter(i=>state==='all'||i.state===state);a.sort((a,b)=>(a.number-b.number)*(q.direction==='asc'?1:-1));return a;}
  comment(subject:any,b:any){const c=this.id('IssueComment',{body:b.body||'',user:this.user()});subject.comments.push(c);return c;}
  pull(r:any,b:any){requireValue(b.title&&b.head&&b.base,422,'title, head and base are required');const head=String(b.head).split(':').at(-1),base=b.base;
    const hs=requireValue(this.tip(r,head),422,'Head ref does not exist'),bs=requireValue(this.tip(r,base),422,'Base ref does not exist');
    const p=this.id('PullRequest',{number:r.next++,title:b.title,body:b.body||'',state:'open',head:{ref:head,sha:hs},base:{ref:base,sha:bs},merged:false,merged_at:null,merge_commit_sha:null,comments:[],_repo:r});r.pulls.set(p.number,p);return p;
  }
  mergeBase(a:string,b:string){const seen=new Set<string>(),todo=[a];while(todo.length){const s=todo.pop()!;if(seen.has(s))continue;seen.add(s);todo.push(...this.objects.commit(s).parents);}const queue=[b];while(queue.length){const s=queue.shift()!;if(seen.has(s))return s;queue.push(...this.objects.commit(s).parents);}return '';}
  changes(p:any){const a=this.objects.files(p.base.sha),b=this.objects.files(p.head.sha);return [...new Set([...a.keys(),...b.keys()])].filter(k=>a.get(k)!==b.get(k)).map(filename=>{const additions=b.has(filename)?this.objects.get(b.get(filename)!)!.data.toString().split('\n').length:0;const deletions=a.has(filename)?this.objects.get(a.get(filename)!)!.data.toString().split('\n').length:0;return {filename,path:filename,status:!a.has(filename)?'added':!b.has(filename)?'removed':'modified',additions,deletions,changes:additions+deletions};});}
  mergeFiles(p:any){const r=p._repo,base=this.tip(r,p.base.ref),head=this.tip(r,p.head.ref);const ancestor=this.mergeBase(base,head);const a=this.objects.files(ancestor),b=this.objects.files(base),h=this.objects.files(head),out=new Map(b);
    for(const key of new Set([...a.keys(),...h.keys()])){if(a.get(key)===h.get(key))continue;if(b.get(key)!==a.get(key)&&b.get(key)!==h.get(key))throw new HttpError(405,'Merge conflict');if(h.has(key))out.set(key,h.get(key)!);else out.delete(key);}return out;
  }
  merge(p:any,b:any={}){if(p.merged)throw new HttpError(405,'Already merged');const r=p._repo,base=this.tip(r,p.base.ref);const sha=this.objects.makeCommit(this.mergeFiles(p),[base],b.commit_title||p.title,++this.sequence);r.refs.set(`refs/heads/${p.base.ref}`,sha);p.state='closed';p.merged=true;p.merged_at=new Date(1700000000000+this.sequence*1000).toISOString();p.merge_commit_sha=sha;return {sha,merged:true,message:'Pull request merged'};}
}
export function publicJson(value:any){return JSON.stringify(value,(key,v)=>key==='_repo'||key==='_type'||v instanceof Map?undefined:v);}
