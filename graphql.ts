// A small selection-set executor: documents are parsed, never matched by operation name.
const fields:any={
  Query:'viewer repository node __type __schema',
  Mutation:'createIssue closeIssue createPullRequest mergePullRequest addComment',
  User:'id login name',
  Repository:'id databaseId name nameWithOwner owner defaultBranchRef viewerPermission hasIssuesEnabled issue issues pullRequest pullRequests',
  Issue:'id number title state body comments',
  PullRequest:'id number title body headRefName baseRefName mergeable state merged files',
  Ref:'name target',Commit:'oid',
  IssueConnection:'nodes edges pageInfo totalCount',PullRequestConnection:'nodes edges pageInfo totalCount',
  PullRequestChangedFileConnection:'nodes edges pageInfo totalCount',IssueCommentConnection:'nodes edges pageInfo totalCount',
  IssueEdge:'node cursor',PullRequestEdge:'node cursor',PullRequestChangedFileEdge:'node cursor',IssueCommentEdge:'node cursor',
  PageInfo:'hasNextPage hasPreviousPage startCursor endCursor',PullRequestChangedFile:'path additions deletions changeType',IssueComment:'id body',
  CreateIssuePayload:'issue clientMutationId',CloseIssuePayload:'issue clientMutationId',CreatePullRequestPayload:'pullRequest clientMutationId',MergePullRequestPayload:'pullRequest clientMutationId',AddCommentPayload:'commentEdge clientMutationId',
  __Type:'kind name description fields enumValues ofType interfaces possibleTypes inputFields',__Field:'name description args type isDeprecated deprecationReason',__EnumValue:'name description isDeprecated deprecationReason',__Schema:'types queryType mutationType subscriptionType directives',
};
const enums:any={IssueState:['OPEN','CLOSED'],PullRequestState:['OPEN','CLOSED','MERGED'],MergeableState:['MERGEABLE','CONFLICTING','UNKNOWN'],SearchType:['ISSUE','REPOSITORY','USER'],PullRequestMergeMethod:['MERGE','SQUASH','REBASE'],RepositoryPermission:['ADMIN','MAINTAIN','WRITE','TRIAGE','READ'],IssueOrderField:['CREATED_AT','UPDATED_AT','COMMENTS'],OrderDirection:['ASC','DESC']};
type Field={name:string,alias:string,args:any,selection:Field[],directives:any[]};
class Parser {
  tokens:string[];p=0;fragments:any={};
  constructor(source:string){this.tokens=source.replace(/#[^\n]*/g,'').match(/\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|[^\s,]/g)||[];}
  peek(){return this.tokens[this.p];}take(){const t=this.tokens[this.p++];if(t===undefined)throw new Error('Unexpected end of document');return t;}
  need(s:string){if(this.take()!==s)throw new Error(`Expected ${s}`);}
  value():any{const t=this.take();if(t==='$')return {variable:this.take()};if(t==='['){const a=[];while(this.peek()!==']')a.push(this.value());this.take();return a;}if(t==='{'){const a:any={};while(this.peek()!=='}'){const k=this.take();this.need(':');a[k]=this.value();}this.take();return a;}if(t[0]==='"')return JSON.parse(t);if(t==='true'||t==='false')return t==='true';if(t==='null')return null;if(/^-?\d/.test(t))return Number(t);return t;}
  args(){const a:any={};if(this.peek()==='('){this.take();while(this.peek()!==')'){const k=this.take();this.need(':');a[k]=this.value();}this.take();}return a;}
  selection():Field[]{this.need('{');const a:any[]=[];while(this.peek()!=='}'){let name=this.take(),alias=name;if(name==='...'){if(this.peek()==='on'){this.take();name=this.take();a.push({name:'...inline',type:name,selection:this.selection(),directives:[]});}else a.push({name:'...fragment',fragment:this.take(),directives:[]});continue;}if(this.peek()===':'){this.take();name=this.take();}const args=this.args(),directives=[];while(this.peek()==='@'){this.take();directives.push({name:this.take(),args:this.args()});}a.push({name,alias,args,directives,selection:this.peek()==='{'?this.selection():[]});}this.take();return a;}
  document(){const ops:any[]=[];while(this.p<this.tokens.length){let kind='query',name='',defaults:any={};if(this.peek()!=='{'){kind=this.take();if(kind==='fragment'){const n=this.take();this.need('on');const type=this.take();this.fragments[n]={type,selection:this.selection()};continue;}if(!['query','mutation'].includes(kind))throw new Error(`Unsupported operation ${kind}`);if(this.peek()!=='('&&this.peek()!=='{')name=this.take();if(this.peek()==='('){this.take();while(this.peek()!==')'){this.need('$');const key=this.take();this.need(':');while(this.peek()!=='='&&this.peek()!=='$'&&this.peek()!==')')this.take();if(this.peek()==='='){this.take();defaults[key]=this.value();}}this.take();}}ops.push({kind,name,defaults,selection:this.selection()});}return ops;}
}
const typed=(type:string,value:any)=>value==null?null:({type,value});
export function graphql(store:any,request:any):any {
  if(Array.isArray(request))return request.map(r=>graphql(store,r));
  try {
    if(typeof request?.query!=='string')throw new Error('query must be a string');
    const parser=new Parser(request.query),ops=parser.document();
    const op=request.operationName?ops.find(x=>x.name===request.operationName):ops.length===1?ops[0]:null;if(!op)throw new Error('Operation name is required or unknown');
    const variables={...op.defaults,...request.variables};
    const val=(x:any):any=>x&&typeof x==='object'?Array.isArray(x)?x.map(val):'variable'in x?variables[x.variable]:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,val(v)])):x;
    const connection=(type:string,a:any[],args:any)=>{
      const start=args.after?Number(Buffer.from(args.after,'base64').toString().split(':')[1])+1:0;
      const n=Math.max(0,args.first??100),slice=a.slice(start,start+n);const cursor=(i:number)=>Buffer.from(`cursor:${i}`).toString('base64');
      return typed(type+'Connection',{nodes:slice.map(x=>typed(type,x)),edges:slice.map((x,i)=>typed(type+'Edge',{node:typed(type,x),cursor:cursor(start+i)})),totalCount:a.length,pageInfo:typed('PageInfo',{hasNextPage:start+n<a.length,hasPreviousPage:start>0,startCursor:slice.length?cursor(start):null,endCursor:slice.length?cursor(start+slice.length-1):null})});
    };
    const byId=(id:string,type?:string)=>{const v=store.nodes.get(id);if(!v||type&&v._type!==type)throw new Error('Unknown node id');return v;};
    const resolve=(type:string,v:any,f:string,a:any):any=>{
      if(f==='__typename')return type;
      if(type==='Query'){
        if(f==='viewer')return typed('User',store.user());
        if(f==='repository'){try{return typed('Repository',store.repo(a.owner,a.name));}catch{return null;}}
        if(f==='node'){const n=store.nodes.get(a.id);return n?typed(n._type,n):null;}
        if(f==='__type')return typeInfo(a.name);
        if(f==='__schema')return typed('__Schema',{types:[...Object.keys(fields),...Object.keys(enums)].map(typeInfo),queryType:typeInfo('Query'),mutationType:typeInfo('Mutation'),subscriptionType:null,directives:[]});
      }
      if(type==='Mutation'){
        const i=a.input||{};let item:any;
        if(f==='createIssue'){item=store.issue(byId(i.repositoryId,'Repository'),i);return typed('CreateIssuePayload',{issue:typed('Issue',item),clientMutationId:i.clientMutationId});}
        if(f==='closeIssue'){item=byId(i.issueId,'Issue');item.state='closed';return typed('CloseIssuePayload',{issue:typed('Issue',item),clientMutationId:i.clientMutationId});}
        if(f==='createPullRequest'){item=store.pull(byId(i.repositoryId,'Repository'),{...i,head:i.headRefName,base:i.baseRefName});return typed('CreatePullRequestPayload',{pullRequest:typed('PullRequest',item)});}
        if(f==='mergePullRequest'){item=byId(i.pullRequestId,'PullRequest');store.merge(item);return typed('MergePullRequestPayload',{pullRequest:typed('PullRequest',item)});}
        if(f==='addComment'){item=store.comment(byId(i.subjectId),i);return typed('AddCommentPayload',{commentEdge:typed('IssueCommentEdge',{node:typed('IssueComment',item)})});}
      }
      if(type==='Repository'){
        if(f==='id')return v.node_id;if(f==='databaseId')return v.id;if(f==='nameWithOwner')return v.full_name;if(f==='owner')return typed('User',v.owner);
        if(f==='defaultBranchRef')return store.tip(v)?typed('Ref',{name:v.default_branch,target:typed('Commit',{oid:store.tip(v)})}):null;
        if(f==='viewerPermission')return 'ADMIN';if(f==='hasIssuesEnabled')return v.has_issues;
        if(f==='issue')return typed('Issue',v.issues.get(a.number));if(f==='pullRequest')return typed('PullRequest',v.pulls.get(a.number));
        if(f==='issues'||f==='pullRequests'){
          let list=[...(f==='issues'?v.issues:v.pulls).values()];if(a.states)list=list.filter((i:any)=>a.states.includes(i.merged?'MERGED':i.state.toUpperCase()));list.sort((x:any,y:any)=>(x.number-y.number)*(a.orderBy?.direction==='DESC'?-1:1));return connection(f==='issues'?'Issue':'PullRequest',list,a);
        }
      }
      if(type==='Issue'||type==='PullRequest'||type==='IssueComment'){
        if(f==='id')return v.node_id;
        if(f==='state')return v.merged?'MERGED':v.state.toUpperCase();
        if(f==='headRefName')return v.head.ref;if(f==='baseRefName')return v.base.ref;
        if(f==='mergeable'){try{store.mergeFiles(v);return 'MERGEABLE';}catch{return 'CONFLICTING';}}
        if(f==='files')return connection('PullRequestChangedFile',store.changes(v),a);
        if(f==='comments')return connection('IssueComment',v.comments,a);
      }
      return v?.[f]??null;
    };
    function typeInfo(name:string):any {if(!fields[name]&&!enums[name])return null;return typed('__Type',{name,kind:enums[name]?'ENUM':'OBJECT',description:null,fields:fields[name]?fields[name].split(' ').map((name:string)=>typed('__Field',{name,description:null,args:[],isDeprecated:false,deprecationReason:null,type:typed('__Type',{kind:'SCALAR',name:'String'})})):null,enumValues:enums[name]?.map((name:string)=>typed('__EnumValue',{name,isDeprecated:false})),interfaces:[],possibleTypes:null,inputFields:null,ofType:null});}
    const project=(obj:any,selection:any[]):any=>{
      if(obj===null||obj===undefined)return null;if(Array.isArray(obj))return obj.map(x=>project(x,selection));
      if(!obj.type)return obj;
      const out:any={};for(const f of selection){
        if(f.name==='...inline'){if(f.type===obj.type||f.type==='Node')Object.assign(out,project(obj,f.selection));continue;}
        if(f.name==='...fragment'){const frag=parser.fragments[f.fragment];if(!frag)throw new Error(`Unknown fragment ${f.fragment}`);if(frag.type===obj.type||frag.type==='Node')Object.assign(out,project(obj,frag.selection));continue;}
        if(f.directives.some((d:any)=>d.name==='skip'&&val(d.args.if)||d.name==='include'&&!val(d.args.if)))continue;
        if(f.name!=='__typename'&&!fields[obj.type]?.split(' ').includes(f.name))throw new Error(`Cannot query field "${f.name}" on type "${obj.type}"`);
        const value=resolve(obj.type,obj.value,f.name,val(f.args));out[f.alias]=f.selection.length?project(value,f.selection):value;
      }return out;
    };
    return {data:project(typed(op.kind==='mutation'?'Mutation':'Query',{}),op.selection)};
  }catch(e){return {data:null,errors:[{message:e instanceof Error?e.message:String(e)}]};}
}
