import { zero } from './objects.ts';
import { HttpError } from './store.ts';

export function pkt(data:Buffer|string){const b=Buffer.isBuffer(data)?data:Buffer.from(data);return Buffer.concat([Buffer.from((b.length+4).toString(16).padStart(4,'0')),b]);}
const flush=Buffer.from('0000'),delim=Buffer.from('0001');
function decode(b:Buffer){const lines:Buffer[]=[];let p=0;while(p+4<=b.length){const s=b.toString('ascii',p,p+4);if(!/^[a-f\d]{4}$/i.test(s))break;const n=parseInt(s,16);p+=4;if(n<=2){lines.push(Buffer.alloc(0));if(n===0)break;continue;}if(n<4||p+n-4>b.length)throw new Error('Invalid packet line');lines.push(b.subarray(p,p+n-4));p+=n-4;}return {lines,p};}
function allLines(b:Buffer){let p=0;const lines:string[]=[];while(p+4<=b.length){const n=parseInt(b.toString('ascii',p,p+4),16);if(!Number.isFinite(n))break;p+=4;if(n<=2)continue;if(n<4||p+n-4>b.length)throw new Error('Invalid packet line');lines.push(b.toString('utf8',p,p+n-4).replace(/\n$/,''));p+=n-4;}return lines;}
function bands(b:Buffer){const out=[];for(let p=0;p<b.length;p+=64000)out.push(pkt(Buffer.concat([Buffer.from([1]),b.subarray(p,p+64000)])));return out;}
export function gitRequest(store:any,r:any,req:any,url:URL,body:Buffer){
  const service=url.searchParams.get('service')||url.pathname.split('/').at(-1);
  if(!['git-upload-pack','git-receive-pack'].includes(service!))throw new HttpError(404,'Unknown git service');
  const upload=service==='git-upload-pack',v2=upload&&req.headers['git-protocol']?.includes('version=2'),o=store.objects;
  const refs=()=>{const a=[...r.refs].map(([ref,sha]:any)=>({ref,sha}));const head=store.tip(r);if(head)a.unshift({ref:'HEAD',sha:head});return a;};
  if(req.method==='GET'){
    let data;
    if(v2)data=Buffer.concat([pkt('version 2\n'),pkt('agent=pocket-forge/1\n'),pkt('ls-refs=unborn\n'),pkt('fetch=shallow wait-for-done\n'),pkt('object-format=sha1\n'),flush]);
    else{
      const caps=upload?`side-band-64k shallow ofs-delta multi_ack_detailed symref=HEAD:refs/heads/${r.default_branch} agent=pocket-forge/1`:'report-status side-band-64k delete-refs ofs-delta agent=pocket-forge/1';
      const list=refs();const lines=list.length?list.map((x:any,i:number)=>pkt(`${x.sha} ${x.ref}${i===0?'\0'+caps:''}\n`)):[pkt(`${zero} capabilities^{}\0${caps}\n`)];
      data=Buffer.concat([pkt(`# service=${service}\n`),flush,...lines,flush]);
    }return {type:`application/x-${service}-advertisement`,data};
  }
  if(!upload){
    const {lines,p}=decode(body);const first=lines.find(x=>x.length)?.toString()||'';const caps=first.split('\0')[1]||'';
    const commands=lines.filter(x=>x.length).map(x=>x.toString().split('\0')[0].trim().split(' '));
    const rest=body.subarray(p);let unpack='ok';try{if(rest.length)o.readPack(rest);}catch(e){unpack=String(e);}
    const reports=[pkt(`unpack ${unpack}\n`)];
    for(const [old,sha,ref] of commands){let error='';const current=r.refs.get(ref)||zero;if(unpack!=='ok')error='unpacker error';else if(current!==old)error='stale old oid';else if(sha!==zero&&!o.get(sha))error='missing object';else if(sha!==zero&&ref.startsWith('refs/heads/')&&!o.ancestor(old,sha))error='non-fast-forward';
      if(!error){if(sha===zero)r.refs.delete(ref);else r.refs.set(ref,sha);}reports.push(pkt(error?`ng ${ref} ${error}\n`:`ok ${ref}\n`));
    }reports.push(flush);const report=Buffer.concat(reports);return {type:'application/x-git-receive-pack-result',data:caps.includes('side-band-64k')?Buffer.concat([...bands(report),flush]):report};
  }
  const lines=allLines(body);
  if(lines.includes('command=ls-refs')){
    const prefixes=lines.filter(x=>x.startsWith('ref-prefix ')).map(x=>x.slice(11));const sym=lines.includes('symrefs'),peel=lines.includes('peel');
    const list=refs().filter((x:any)=>!prefixes.length||prefixes.some(p=>x.ref.startsWith(p))).map((x:any)=>{let attrs='';if(sym&&x.ref==='HEAD')attrs+=` symref-target:refs/heads/${r.default_branch}`;if(peel&&o.get(x.sha)?.type==='tag'){const target=/^object (\w+)/.exec(o.get(x.sha).data.toString())?.[1];if(target)attrs+=` peeled:${target}`;}return pkt(`${x.sha} ${x.ref}${attrs}\n`);});
    return {type:'application/x-git-upload-pack-result',data:Buffer.concat([...list,flush])};
  }
  const wants=lines.filter(x=>x.startsWith('want ')).map(x=>x.split(' ')[1]);const haves=lines.filter(x=>x.startsWith('have ')).map(x=>x.split(' ')[1]);
  const depthLine=lines.find(x=>x.startsWith('deepen ')),depth=depthLine?Number(depthLine.slice(7)):Infinity;
  const oldShallow=lines.filter(x=>x.startsWith('shallow ')).map(x=>x.slice(8));
  // A shallow client's have does not imply ownership of its ancestors. For
  // shallow negotiation, walk the requested depth without have exclusions;
  // resending known objects is safe. Ordinary incremental fetches still prune
  // haves and their complete ancestry exactly as before.
  const reach=o.reachable(wants,depth,oldShallow.length?[]:haves);
  const pack=o.pack(reach.ids),out:Buffer[]=[];
  const delivered=new Set(reach.ids);
  // An old boundary outside this walk must remain shallow: we did not supply
  // its missing ancestry merely by fetching an unrelated or newer tip.
  const unshallow=oldShallow.filter(x=>delivered.has(x)&&!reach.shallow.includes(x));
  if(v2||lines.includes('command=fetch')){
    out.push(pkt('acknowledgments\n'));const ack=haves.filter(x=>o.get(x));if(ack.length)out.push(...ack.map(x=>pkt(`ACK ${x}\n`)),pkt('ready\n'));else out.push(pkt('NAK\n'));out.push(delim);
    if(reach.shallow.length||unshallow.length){out.push(pkt('shallow-info\n'),...reach.shallow.map((x:string)=>pkt(`shallow ${x}\n`)),...unshallow.map(x=>pkt(`unshallow ${x}\n`)),delim);}
    out.push(pkt('packfile\n'),...bands(pack),flush);
  }else{if(reach.shallow.length||unshallow.length)out.push(...reach.shallow.map((x:string)=>pkt(`shallow ${x}\n`)),...unshallow.map(x=>pkt(`unshallow ${x}\n`)),flush);out.push(pkt('NAK\n'),...bands(pack),flush);}
  return {type:'application/x-git-upload-pack-result',data:Buffer.concat(out)};
}
