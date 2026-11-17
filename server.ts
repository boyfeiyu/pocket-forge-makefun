import { createServer } from 'node:http';
import { Store, HttpError, publicJson } from './store.ts';
import { rest } from './rest.ts';
import { gitRequest } from './git.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';

export function createApp(){
  const store=new Store();let requestId=0;
  return createServer(async(req,res)=>{
    res.setHeader('X-GitHub-Request-Id',`PF-${++requestId}`);
    const json=(body:any,status=200,headers:any={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8',...headers});res.end(status===204?'':publicJson(body));};
    let url:URL;try{url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);}catch{return json({message:'Bad URL'},400);}
    const path=url.pathname,method=req.method||'GET';
    if(path==='/healthz')return json({ok:true});
    const token=process.env.MAKEFUN_SHOP_TOKEN;
    if(!token||req.headers.authorization!==`Bearer ${token}`)return json({message:'Requires authentication'},401);
    try{
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>128*1024*1024)throw new HttpError(413,'Request too large');chunks.push(chunk);}const body=Buffer.concat(chunks);
      if(/^\/[^/]+\/[^/]+\.git\//.test(path)){
        const parts=path.split('/');const r=store.repo(decodeURIComponent(parts[1]),decodeURIComponent(parts[2].slice(0,-4)));const result=gitRequest(store,r,req,url,body);res.writeHead(200,{'content-type':result.type,'cache-control':'no-cache'});return res.end(result.data);
      }
      let b:any={};if(body.length){try{b=JSON.parse(body.toString());}catch{return path==='/mcp'?json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400):json({message:'Malformed JSON'},400);}}
      if(path==='/mcp'&&method==='POST'){const out=mcp(store,b);return out===null?json(null,202):json(out);}
      if(path==='/api/graphql'&&method==='POST')return json(graphql(store,b));
      if(path.startsWith('/api/v3')){const result=rest(store,method,path,url.searchParams,b,url.origin);return json(result.body,result.status,result.headers);}
      throw new HttpError(404,'Not Found');
    }catch(e){if(!(e instanceof HttpError))console.error('Request error:',e);return json({message:e instanceof Error?e.message:String(e)},e instanceof HttpError?e.status:500);}
  });
}
