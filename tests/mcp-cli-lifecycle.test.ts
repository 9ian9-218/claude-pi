import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PROJECT_ROOT } from "../src/config.ts";
import { trustProjectCode } from "../src/workspace-trust.ts";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { MCP_FIXTURE_SOURCE } from "./helpers/mcp-fixture.ts";

const require=createRequire(import.meta.url),tsx=require.resolve("tsx/cli"),entry=path.join(PROJECT_ROOT,"src/cli.ts");
let root:string,store:string,original:string|undefined,children:ChildProcess[];
beforeEach(()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),"cpi-mcp-cli-"));store=path.join(root,"config");fs.mkdirSync(store);
  original=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=store;children=[];
});
afterEach(()=>{
  for(const child of children)if(child.exitCode===null)child.kill("SIGKILL");
  for(const file of ["pid","child"])if(fs.existsSync(path.join(root,file))){const id=Number(fs.readFileSync(path.join(root,file),"utf8"));if(alive(id)){try{process.kill(id,"SIGKILL");}catch{}}}
  if(original===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=original;fs.rmSync(root,{recursive:true,force:true});
});
const env=()=>({...process.env,PI_CODING_AGENT_DIR:store,PI_OFFLINE:"1"});
function alive(id:number){try{process.kill(id,0);if(process.platform==="linux")return !/\) Z /.test(fs.readFileSync(`/proc/${id}/stat`,"utf8"));return true;}catch{return false;}}
async function until(test:()=>boolean){const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw new Error("CLI did not reach expected state");await delay(20);}}
function setup(mode="normal",trusted=true){
  const server=path.join(root,"server.cjs");fs.writeFileSync(server,MCP_FIXTURE_SOURCE);fs.mkdirSync(path.join(root,".agent"));
  fs.writeFileSync(path.join(root,".agent/mcp.json"),JSON.stringify({mcpServers:{peer:{command:process.execPath,args:[server],autoConnect:true,env:{MODE:mode,PID_FILE:path.join(root,"pid"),CHILD_FILE:path.join(root,"child")},limits:{shutdownGraceMs:40,startupTimeoutMs:5000}}}}));
  if(trusted)trustProjectCode(root);
}
function launch(args:string[],input:string=""){
  const child=spawn(process.execPath,[tsx,entry,...args],{cwd:root,env:env(),stdio:["pipe","pipe","pipe"]});children.push(child);
  const done=new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}));});
  child.stdin.end(input);return {child,done};
}
function models(url:string){
  fs.writeFileSync(path.join(store,"models.json"),JSON.stringify({providers:{smoke:{baseUrl:url,api:"openai-completions",apiKey:"local-test-key",compat:{supportsDeveloperRole:false},models:[{id:"smoke",name:"smoke",contextWindow:128000,maxTokens:8000}]}}}));
  fs.writeFileSync(path.join(store,"settings.json"),JSON.stringify({defaultModel:"smoke/smoke",retry:{enabled:false,maxRetries:0}}));
}

describe("CLI MCP lifecycle",()=>{
  it("autoconnects in REPL and reaps the peer before EOF exit",async()=>{
    setup("stubborn");const result=await launch(["--repl"],"q\n").done;expect(result.code,result.stderr).toBe(0);expect(result.stderr).toContain("[mcp] connected");
    expect(alive(Number(fs.readFileSync(path.join(root,"pid"),"utf8")))).toBe(false);expect(alive(Number(fs.readFileSync(path.join(root,"child"),"utf8")))).toBe(false);
  },15000);
  it("does not launch untrusted automatic MCP configuration",async()=>{
    setup("normal",false);const result=await launch(["--repl"],"q\n").done;expect(result.code).toBe(0);expect(result.stderr).toContain("--trust-project-code");expect(fs.existsSync(path.join(root,"pid"))).toBe(false);
  },15000);
  it.each(["print","json"])("cleans MCP after %s mode without polluting stdout",async mode=>{
    setup("stubborn");const mock=await MockOpenAI.create();try{
      models(mock.baseUrl);mock.push(()=>({kind:"sse",chunks:[{content:"MCP_CLI_OK",finishReason:"stop"}]}));
      const result=await launch(mode==="print"?["-p","--no-session","say ok"]:["--mode","json","--no-session","say ok"]).done;
      expect(result.code,result.stderr).toBe(0);expect(result.stderr).toContain("[mcp] connected");
      if(mode==="print")expect(result.stdout.trim()).toBe("MCP_CLI_OK");else expect(JSON.parse(result.stdout)).toMatchObject({status:"success",final:"MCP_CLI_OK"});
      expect(alive(Number(fs.readFileSync(path.join(root,"pid"),"utf8")))).toBe(false);expect(alive(Number(fs.readFileSync(path.join(root,"child"),"utf8")))).toBe(false);
      expect(JSON.stringify(mock.requests[0].tools)).toContain("mcp__peer__echo");
    }finally{await mock.close();}
  },20000);
  it("SIGTERM during initialization cancels startup and joins descendant cleanup",async()=>{
    setup("startup-child");const run=launch(["--repl"],"q\n");await until(()=>fs.existsSync(path.join(root,"child")));run.child.kill("SIGTERM");const result=await run.done;
    expect(result.code,result.stderr).toBe(130);expect(alive(Number(fs.readFileSync(path.join(root,"pid"),"utf8")))).toBe(false);expect(alive(Number(fs.readFileSync(path.join(root,"child"),"utf8")))).toBe(false);
  },15000);
  it("joins MCP cleanup before the fatal handler exits",async()=>{
    setup("stubborn");const script=path.join(root,"fatal.mts");fs.writeFileSync(script,`
import {MCPHub} from ${JSON.stringify(path.join(PROJECT_ROOT,"src/mcp/hub.ts"))};
import {installFatalHandlers} from ${JSON.stringify(path.join(PROJECT_ROOT,"src/fatal.ts"))};
const hub=new MCPHub(${JSON.stringify(root)});installFatalHandlers(()=>hub.shutdown());await hub.connectFromConfig();setTimeout(()=>{throw new Error('fatal-with-mcp')},20);
`);
    const result=await new Promise<{code:number|string;stderr:string}>(resolve=>execFile(process.execPath,[tsx,script],{cwd:root,env:env(),timeout:10000},(error,_stdout,stderr)=>resolve({code:(error as {code?:number|string})?.code??0,stderr})));
    expect(result.code,result.stderr).toBe(1);expect(result.stderr).toContain("fatal-with-mcp");expect(alive(Number(fs.readFileSync(path.join(root,"pid"),"utf8")))).toBe(false);expect(alive(Number(fs.readFileSync(path.join(root,"child"),"utf8")))).toBe(false);
  },15000);
  it.runIf(process.platform==="linux")("cleans MCP before TUI /quit on a real pseudo-terminal",async()=>{
    setup("stubborn");const python=String.raw`
import os,pty,select,time,json,signal,sys
node,tsx,entry,root=sys.argv[1:]
pid,fd=pty.fork()
if pid==0:
 os.chdir(root);os.execv(node,[node,tsx,entry])
output=b'';sent=False;end=time.monotonic()+12
try:
 while time.monotonic()<end:
  ready,_,_=select.select([fd],[],[],0.05)
  if ready:
   try: output+=os.read(fd,65536)
   except OSError: pass
  if not sent and '输入 /help'.encode() in output:
   os.write(fd,b'/quit\r');sent=True
  done,status=os.waitpid(pid,os.WNOHANG)
  if done:
   print(json.dumps({'code':os.waitstatus_to_exitcode(status),'sentQuit':sent,'bytes':len(output)}));break
 else:
  os.kill(pid,signal.SIGKILL);os.waitpid(pid,0);raise RuntimeError('TUI did not exit')
finally:
 os.close(fd)
`;
    const result=await new Promise<string>((resolve,reject)=>execFile("python3",["-c",python,process.execPath,tsx,entry,root],{env:env(),timeout:15000},(error,stdout,stderr)=>error?reject(new Error(stderr)):resolve(stdout)));
    expect(JSON.parse(result)).toMatchObject({code:0,sentQuit:true});expect(alive(Number(fs.readFileSync(path.join(root,"pid"),"utf8")))).toBe(false);expect(alive(Number(fs.readFileSync(path.join(root,"child"),"utf8")))).toBe(false);
  },20000);
});
