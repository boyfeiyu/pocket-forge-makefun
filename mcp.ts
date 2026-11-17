import { requireValue } from './store.ts';
const specs:any[]=[
  ['create_repo','Create a repository in the authenticated namespace',{name:{type:'string'},description:{type:'string'},private:{type:'boolean'}},['name']],
  ['get_repo','Read a repository',{owner:{type:'string'},repo:{type:'string'}},['owner','repo']],
  ['create_issue','Open an issue',{owner:{type:'string'},repo:{type:'string'},title:{type:'string'},body:{type:'string'}},['owner','repo','title']],
  ['list_issues','List issues filtered by state',{owner:{type:'string'},repo:{type:'string'},state:{type:'string'}},['owner','repo']],
  ['create_pull_request','Open a pull request between branches',{owner:{type:'string'},repo:{type:'string'},title:{type:'string'},head:{type:'string'},base:{type:'string'},body:{type:'string'}},['owner','repo','title','head','base']],
  ['merge_pull_request','Squash merge a conflict-free pull request',{owner:{type:'string'},repo:{type:'string'},pull_number:{type:'integer'}},['owner','repo','pull_number']],
];
const tools=specs.map(([name,description,properties,required])=>({name,description,inputSchema:{type:'object',properties,required}}));
export function mcp(store:any,b:any):any {
  if(Array.isArray(b))return b.map(x=>mcp(store,x));
  const reply=(result:any)=>({jsonrpc:'2.0',id:b.id??null,result});const error=(code:number,message:string)=>({jsonrpc:'2.0',id:b.id??null,error:{code,message}});
  if(b.jsonrpc!=='2.0'||typeof b.method!=='string')return error(-32600,'Invalid request');
  if(b.method==='server/discover')return reply({supportedVersions:['2026-07-28','2025-11-25'],serverInfo:{name:'pocket-forge',version:'1.0.0'},capabilities:{tools:{}}});
  if(b.method==='initialize')return reply({protocolVersion:['2026-07-28','2025-11-25','2025-06-18','2024-11-05'].includes(b.params?.protocolVersion)?b.params.protocolVersion:'2026-07-28',capabilities:{tools:{listChanged:false}},serverInfo:{name:'pocket-forge',version:'1.0.0'}});
  if(b.method.startsWith('notifications/'))return null;
  if(b.method==='ping')return reply({});
  if(b.method==='tools/list')return reply({tools});
  if(b.method!=='tools/call')return error(-32601,'Method not found');
  const tool=tools.find(t=>t.name===b.params?.name);if(!tool)return error(-32602,'Unknown tool');
  const a=b.params.arguments||{};for(const key of tool.inputSchema.required)if(a[key]===undefined||a[key]===null||a[key]==='')return error(-32602,`Missing required argument: ${key}`);
  try{
    let result;
    if(tool.name==='create_repo')result=store.createRepo(a);
    else {const r=store.repo(a.owner,a.repo);switch(tool.name){case 'get_repo':result=r;break;case 'create_issue':result=store.issue(r,a);break;case 'list_issues':result=store.list(r,'issues',a);break;case 'create_pull_request':result=store.pull(r,a);break;case 'merge_pull_request':result=store.merge(requireValue(r.pulls.get(Number(a.pull_number))));break;}}
    // The HTTP layer strips private links before serializing the nested tool text.
    const text=JSON.stringify(result,(k,v)=>k.startsWith('_')||v instanceof Map?undefined:v);
    return reply({content:[{type:'text',text}],isError:false});
  }catch(e){return reply({content:[{type:'text',text:String(e)}],isError:true});}
}
