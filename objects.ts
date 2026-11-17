import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const zero = '0'.repeat(40);
export const digest = (b: Buffer) => createHash('sha1').update(b).digest('hex');
export type Obj = {type:string, data:Buffer};
export class Objects {
  items = new Map<string,Obj>();
  put(type:string, value:Buffer|string) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const sha = digest(Buffer.concat([Buffer.from(`${type} ${data.length}\0`),data]));
    this.items.set(sha,{type,data}); return sha;
  }
  get(sha:string) { return this.items.get(sha); }
  commit(sha:string) {
    const text = this.get(sha)?.data.toString() || '';
    return {tree:/^tree (\w+)/m.exec(text)?.[1] || '', parents:[...text.matchAll(/^parent (\w+)/gm)].map(x=>x[1]), message:text.split('\n\n').slice(1).join('\n\n')};
  }
  tree(sha:string): {name:string,mode:string,sha:string}[] {
    const b = this.get(sha)?.data || Buffer.alloc(0); const out=[];
    let i=0;
    while(i<b.length) {
      const s=b.indexOf(32,i), n=b.indexOf(0,s); if(s<0 || n<0 || n+21>b.length) throw new Error('Malformed tree');
      out.push({mode:b.toString('utf8',i,s),name:b.toString('utf8',s+1,n),sha:b.subarray(n+1,n+21).toString('hex')}); i=n+21;
    } return out;
  }
  files(commit:string) {
    const result = new Map<string,string>();
    const walk=(sha:string,prefix:string)=>{for(const e of this.tree(sha)) { if(e.mode==='40000' || e.mode==='040000') walk(e.sha,prefix+e.name+'/'); else result.set(prefix+e.name,e.sha); }};
    if(commit) walk(this.commit(commit).tree,''); return result;
  }
  writeTree(files:Map<string,string>) {
    const root:any = new Map();
    for(const [path,sha] of files) { const parts=path.split('/'); let dir=root; for(const name of parts.slice(0,-1)) { if(!dir.has(name)) dir.set(name,new Map()); dir=dir.get(name); } dir.set(parts.at(-1),sha); }
    const build=(dir:any):string=>{
      const rows=[...dir].map(([name,value]:any)=>({name,dir:value instanceof Map,sha:value instanceof Map?build(value):value}));
      rows.sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.dir?'/':'')),Buffer.from(b.name+(b.dir?'/':''))));
      return this.put('tree',Buffer.concat(rows.flatMap(x=>[Buffer.from(`${x.dir?'40000':'100644'} ${x.name}\0`),Buffer.from(x.sha,'hex')])));
    }; return build(root);
  }
  makeCommit(files:Map<string,string>, parents:string[], message:string, sequence:number, author='Pocket Forge <forge@localhost>') {
    return this.put('commit',`tree ${this.writeTree(files)}\n${parents.filter(Boolean).map(p=>`parent ${p}\n`).join('')}author ${author} ${1700000000+sequence} +0000\ncommitter ${author} ${1700000000+sequence} +0000\n\n${message}\n`);
  }
  ancestor(older:string,newer:string) {
    if(!older || older===zero) return true;
    const todo=[newer],seen=new Set();
    while(todo.length) { const sha=todo.pop()!; if(sha===older) return true; if(seen.has(sha)) continue; seen.add(sha); if(this.get(sha)?.type==='commit') todo.push(...this.commit(sha).parents); } return false;
  }
  reachable(wants:string[], depth=Infinity, exclude:string[]=[]) {
    const result=new Set<string>(), shallow=new Set<string>();
    const excluded=new Set<string>();
    const skip=(sha:string)=>{if(excluded.has(sha))return; excluded.add(sha); const o=this.get(sha); if(!o)return; if(o.type==='commit'){const c=this.commit(sha);skip(c.tree);c.parents.forEach(skip);}else if(o.type==='tree')this.tree(sha).forEach(x=>skip(x.sha));else if(o.type==='tag'){const s=/^object (\w+)/.exec(o.data.toString())?.[1];if(s)skip(s);}};
    exclude.forEach(skip);
    const walk=(sha:string, level:number)=>{
      if(result.has(sha)||excluded.has(sha))return; const o=this.get(sha); if(!o)return; result.add(sha);
      if(o.type==='commit'){const c=this.commit(sha);walk(c.tree,level);if(level<depth)c.parents.forEach(p=>walk(p,level+1));else if(c.parents.length)shallow.add(sha);}
      if(o.type==='tree')this.tree(sha).forEach(e=>walk(e.sha,level));
      if(o.type==='tag'){const s=/^object (\w+)/.exec(o.data.toString())?.[1];if(s)walk(s,level);}
    }; wants.forEach(w=>walk(w,1)); return {ids:[...result],shallow:[...shallow]};
  }
  pack(ids:string[]) {
    const head=Buffer.alloc(12);head.write('PACK');head.writeUInt32BE(2,4);head.writeUInt32BE(ids.length,8);
    const chunks=[head];
    for(const id of ids){const o=this.get(id)!;let size=o.data.length;const type=['','commit','tree','blob','tag'].indexOf(o.type);const bytes=[(type<<4)|(size&15)];size=Math.floor(size/16);while(size){bytes[bytes.length-1]|=128;bytes.push(size&127);size=Math.floor(size/128);}chunks.push(Buffer.from(bytes),deflateSync(o.data,{level:1}));}
    const b=Buffer.concat(chunks);return Buffer.concat([b,Buffer.from(digest(b),'hex')]);
  }
  readPack(b:Buffer) {
    if(b.length<32 || b.toString('ascii',0,4)!=='PACK')throw new Error('Invalid pack');
    if(digest(b.subarray(0,-20))!==b.subarray(-20).toString('hex'))throw new Error('Pack checksum mismatch');
    if(![2,3].includes(b.readUInt32BE(4)))throw new Error('Unsupported pack version');
    const count=b.readUInt32BE(8), records:any[]=[], offsets=new Map<number,any>();let p=12;
    for(let i=0;i<count;i++){
      const offset=p;let v=b[p++],type=(v>>4)&7,size=v&15,shift=4;
      while(v&128){v=b[p++];size+=(v&127)*2**shift;shift+=7;}
      let base:any=null;
      if(type===6){v=b[p++];let distance=v&127;while(v&128){v=b[p++];distance=((distance+1)*128)+(v&127);}base=offset-distance;}
      if(type===7){base=b.subarray(p,p+20).toString('hex');p+=20;}
      const z:any=inflateSync(b.subarray(p),{info:true,maxOutputLength:128*1024*1024});p+=z.engine.bytesWritten;
      if(z.buffer.length!==size)throw new Error('Pack object size mismatch');
      const r={type,data:z.buffer,base,sha:null};records.push(r);offsets.set(offset,r);
    }
    if(p!==b.length-20)throw new Error('Unexpected pack trailing bytes');
    const resolve=(r:any):Obj|null=>{
      if(!r)return null;
      if(r.sha)return this.get(r.sha)!;
      if(r.type===6 || r.type===7){const base=typeof r.base==='number'?resolve(offsets.get(r.base)):this.get(r.base);if(!base)return null;r.data=applyDelta(base.data,r.data);r.type=['','commit','tree','blob','tag'].indexOf(base.type);}
      const type=['','commit','tree','blob','tag'][r.type];if(!type)throw new Error('Invalid object type');r.sha=this.put(type,r.data);return this.get(r.sha)!;
    };records.filter(r=>r.type<6).forEach(resolve);
    let pending=records.filter(r=>!r.sha);
    while(pending.length){const before=pending.length;pending.forEach(resolve);pending=pending.filter(r=>!r.sha);if(pending.length===before)throw new Error('Missing or cyclic delta base');}
  }
}
function applyDelta(base:Buffer,d:Buffer) {
  let p=0;const read=()=>{let n=0,s=0,b;do{b=d[p++];n+=(b&127)*2**s;s+=7;}while(b&128);return n;};
  if(read()!==base.length)throw new Error('Delta base size');const size=read(),parts=[];
  while(p<d.length){const code=d[p++];if(code&128){let off=0,len=0;for(let i=0;i<4;i++)if(code&(1<<i))off+=d[p++]*2**(i*8);for(let i=0;i<3;i++)if(code&(1<<(i+4)))len+=d[p++]*2**(i*8);parts.push(base.subarray(off,off+(len||65536)));}else if(code){parts.push(d.subarray(p,p+code));p+=code;}else throw new Error('Invalid delta opcode');}
  const out=Buffer.concat(parts);if(out.length!==size)throw new Error('Delta result size');return out;
}
