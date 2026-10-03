/** Fault-injection peer: raw JSON-RPC, no SDK dependency, credentials or external service. */
export const MCP_FIXTURE_SOURCE = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const mode = process.env.MODE || 'normal';
const send = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const ok = (id,text='ok') => send(id,{content:[{type:'text',text}]});
const names = ['echo','hang','stderr','garbage','overflow','deep','tokens','invalid_utf8','invalid_result','exit','delay','flood','big','error'];
if(process.env.PID_FILE)fs.writeFileSync(process.env.PID_FILE,String(process.pid));
if(process.env.START_FILE)fs.appendFileSync(process.env.START_FILE,'start\n');
if(mode==='stubborn'||mode==='startup-child') {
  process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
  if(process.env.CHILD_FILE)fs.writeFileSync(process.env.CHILD_FILE,String(child.pid));
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize') {
    if(mode==='no-init'||mode==='startup-child')return;
    const respond=()=>send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
    if(mode==='slow-start')setTimeout(respond,80);else respond();
  } else if(m.method==='tools/list') {
    if(mode==='no-list')return;
    const count=mode==='too-many-tools'?200:names.length;
    let tools=Array.from({length:count},(_,i)=>({name:names[i]||'t'+i,inputSchema:{type:'object',properties:{text:{type:'string'},count:{type:'integer'}},additionalProperties:false}}));
    if(mode==='collision')tools=[{name:'a b',inputSchema:{type:'object'}},{name:'a_b',inputSchema:{type:'object'}}];
    if(mode==='original-name')tools=[{name:'echo words',inputSchema:{type:'object'}}];
    if(mode==='large-metadata')tools[0].description='x'.repeat(5000);
    if(mode==='schema')tools[0].outputSchema={type:'object',properties:{value:{type:'integer'}},required:['value']};
    const respond=()=>send(m.id,{tools});
    if(mode==='slow-start')setTimeout(respond,80);else respond();
  } else if(m.method==='tools/call') {
    if(process.env.CALL_FILE)fs.appendFileSync(process.env.CALL_FILE,m.params.name+'\n');
    const {name,arguments:args={}}=m.params;
    if(name==='hang')return;
    if(name==='echo'||name==='echo words'){
      if(mode==='schema')send(m.id,{content:[{type:'text',text:'validated'}],structuredContent:{value:args.count??7}});
      else ok(m.id,args.text||name);
    }
    if(name==='stderr')process.stderr.write(Buffer.alloc(args.count||2*1024*1024,120),()=>ok(m.id));
    if(name==='garbage'){process.stdout.write('not json\n'.repeat(args.count||1));ok(m.id);}
    if(name==='overflow')process.stdout.write(Buffer.alloc(args.count||4096,120));
    if(name==='deep')process.stdout.write('{"jsonrpc":"2.0","id":'+m.id+',"result":{"content":[],"structuredContent":{"x":'+'['.repeat(150)+'0'+']'.repeat(150)+'}}}\n');
    if(name==='tokens')send(m.id,{content:[],structuredContent:{items:Array(2000).fill(0)}});
    if(name==='invalid_utf8')process.stdout.write(Buffer.from([255,10]));
    if(name==='invalid_result')send(m.id,{content:'invalid'});
    if(name==='exit')process.exit(23);
    if(name==='delay')setTimeout(()=>ok(m.id),args.count||150);
    if(name==='flood')for(let i=0;i<(args.count||300);i++)process.stdout.write('{"jsonrpc":"2.0","method":"fixture/notice"}\n');
    if(name==='big')ok(m.id,'\x1b[31m'+('中\x00'.repeat(args.count||10000))+'\x1b[0m');
    if(name==='error')send(m.id,{isError:true,content:[{type:'text',text:'business error'}]});
  }
});
process.stdin.on('end',()=>{if(mode!=='stubborn'&&mode!=='startup-child')process.exit(0);});
`;
