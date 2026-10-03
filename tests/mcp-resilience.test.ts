import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { MCPHub, getMCPHub, resetMCPHub, McpCallError } from "../src/mcp/hub.ts";
import { resolveMcpLimits, cleanMcpText } from "../src/mcp/limits.ts";
import { ManagedStdioTransport } from "../src/mcp/stdio-transport.ts";
import { finalizeMcpToolOutput } from "../src/mcp/output.ts";
import { loadMcpConfig, type McpServerConfig } from "../src/mcp/config.ts";
import { trustProjectCode } from "../src/workspace-trust.ts";
import { executeToolCallResult, getOpenaiTools } from "../src/tools/runtime.ts";
import { runWithWorkdir } from "../src/workdir.ts";
import { createAgentContext, runWithAgentContext } from "../src/teammates/context.ts";
import { withMcpLifecycle } from "../src/mcp/lifecycle.ts";
import { MCP_FIXTURE_SOURCE } from "./helpers/mcp-fixture.ts";

let root: string, script: string, hub: MCPHub, originalDir: string | undefined;
beforeEach(() => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),"cpi-mcp-resilience-"));
  script=path.join(root,"server.cjs");fs.writeFileSync(script,MCP_FIXTURE_SOURCE);
  originalDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=path.join(root,"config");
  resetMCPHub();hub=getMCPHub(root);
});
afterEach(async()=>{await hub.shutdown();resetMCPHub();if(originalDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=originalDir;fs.rmSync(root,{recursive:true,force:true});});
const config=(mode="normal",limits: McpServerConfig["limits"]={}):McpServerConfig=>({name:"peer",command:process.execPath,args:[script],cwd:root,env:{MODE:mode,PID_FILE:path.join(root,"pid"),CHILD_FILE:path.join(root,"child"),START_FILE:path.join(root,"starts"),CALL_FILE:path.join(root,"calls")},autoConnect:false,limits:{shutdownGraceMs:30,startupTimeoutMs:1500,requestTimeoutMs:250,cooldownMs:50,...limits}});
function alive(pid:number):boolean {try{process.kill(pid,0);if(process.platform==="linux")return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`,"utf8"));return true;}catch{return false;}}
const pid=()=>Number(fs.readFileSync(path.join(root,"pid"),"utf8"));
async function until(test:()=>boolean,ms=3000):Promise<void>{const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw new Error("condition did not settle");await delay(10);}}
async function configured(cfg:McpServerConfig):Promise<void>{fs.mkdirSync(path.join(root,".agent"),{recursive:true});fs.writeFileSync(path.join(root,".agent/mcp.json"),JSON.stringify({mcpServers:{peer:{...cfg,name:undefined,cwd:root}}}));trustProjectCode(root);}

describe("MCP stdio process and fault supervision",()=>{
  it("drains 2 MiB stderr while retaining only a bounded diagnostic tail",async()=>{
    await hub.connectStdio(config("normal",{requestTimeoutMs:1000}));
    await expect(hub.callPrefixedTool("mcp__peer__stderr",{count:2*1024*1024})).resolves.toBe("ok");
    const state=hub.listServerStatus()[0];expect(state.status).toBe("ready");expect(String(state.stderrTail).length).toBeLessThanOrEqual(1024);
  });
  it("opens the circuit on three consecutive timeouts and terminates the server",async()=>{
    await hub.connectStdio(config());const processId=pid();
    for(let i=0;i<3;i++)await expect(hub.callPrefixedTool("mcp__peer__hang",{})).rejects.toMatchObject({status:"timeout"});
    expect(hub.listServers()).toEqual([]);expect(hub.getTool("mcp__peer__hang")).toBeNull();
    await expect(hub.callPrefixedTool("mcp__peer__hang",{})).rejects.toThrow("circuit");
    await until(()=>!alive(processId));expect(hub.listServerStatus()[0].status).toBe("open");
  });
  it("resets failures after success and does not count business errors",async()=>{
    await hub.connectStdio(config());await expect(hub.callPrefixedTool("mcp__peer__hang",{})).rejects.toBeInstanceOf(McpCallError);
    expect(hub.listServerStatus()[0].consecutiveFailures).toBe(1);
    await hub.callPrefixedTool("mcp__peer__echo",{text:"hello"});expect(hub.listServerStatus()[0].consecutiveFailures).toBe(0);
    for(let i=0;i<4;i++)expect(JSON.parse(await hub.callPrefixedTool("mcp__peer__error",{})).status).toBe("error");
    expect(hub.listServerStatus()[0].status).toBe("ready");
  });
  it("propagates cancellation without poisoning server health",async()=>{
    await hub.connectStdio(config());const controller=new AbortController();const request=hub.callPrefixedTool("mcp__peer__hang",{},controller.signal);controller.abort();
    await expect(request).rejects.toMatchObject({status:"cancelled"});expect(hub.listServerStatus()[0].consecutiveFailures).toBe(0);expect(alive(pid())).toBe(true);
  });
  it("removes tools immediately after unexpected process exit",async()=>{
    await hub.connectStdio(config());await expect(hub.callPrefixedTool("mcp__peer__exit",{})).rejects.toThrow();
    await until(()=>hub.listServers().length===0);expect(hub.listTools()).toEqual([]);
  });
  it("limits malformed lines but tolerates a single malformed frame",async()=>{
    await hub.connectStdio(config());expect(await hub.callPrefixedTool("mcp__peer__garbage",{count:1})).toBe("ok");
    await expect(hub.callPrefixedTool("mcp__peer__garbage",{count:3})).rejects.toThrow();
    expect(hub.listServerStatus()[0]).toMatchObject({status:"open",lastError:expect.stringContaining("protocol")});
  });
  it("rejects invalid UTF-8 without reflecting peer bytes into diagnostics",async()=>{
    await hub.connectStdio(config("normal",{maxProtocolErrors:1}));await expect(hub.callPrefixedTool("mcp__peer__invalid_utf8",{})).rejects.toThrow();
    expect(hub.listServerStatus()[0].lastError).toContain("protocol");
  });
  it("rejects an oversized unterminated frame before JSON parsing",async()=>{
    await hub.connectStdio(config("normal",{maxFrameBytes:4096}));await expect(hub.callPrefixedTool("mcp__peer__overflow",{count:8192})).rejects.toThrow();
    expect(hub.listServerStatus()[0].lastError).toContain("frame byte limit");
  });
  it("limits nested JSON and large collections before parsing",async()=>{
    await hub.connectStdio(config("normal",{maxJsonDepth:16}));await expect(hub.callPrefixedTool("mcp__peer__deep",{})).rejects.toThrow();expect(hub.listServers()).toEqual([]);
    await hub.disconnect("peer");await hub.connectStdio(config("normal",{maxJsonTokens:1000}));await expect(hub.callPrefixedTool("mcp__peer__tokens",{})).rejects.toThrow();expect(hub.listServers()).toEqual([]);
  });
  it("limits message floods even when each frame is small and valid",async()=>{
    await hub.connectStdio(config("normal",{maxMessagesPerSecond:30}));await expect(hub.callPrefixedTool("mcp__peer__flood",{count:80})).rejects.toThrow();
    expect(hub.listServerStatus()[0].lastError).toContain("messages rate");
  });
  it("limits stderr byte floods while continuing to drain pipes",async()=>{
    await hub.connectStdio(config("normal",{maxStderrBytesPerSecond:1024}));const processId=pid();
    // Independent stdout/stderr pipes can deliver the response before the flood.
    await hub.callPrefixedTool("mcp__peer__stderr",{count:8192}).catch(()=>undefined);
    await until(()=>hub.listServerStatus()[0].status==="open");
    expect(hub.listServerStatus()[0].lastError).toContain("stderr rate");
    expect(hub.listTools()).toEqual([]);
    await expect(hub.callPrefixedTool("mcp__peer__echo",{})).rejects.toThrow("circuit");
    await until(()=>!alive(processId));
  });
  it("uses one startup deadline across initialize and tools/list",async()=>{
    await expect(hub.connectStdio(config("slow-start",{startupTimeoutMs:120}))).rejects.toMatchObject({status:"timeout"});await until(()=>!alive(pid()));expect(hub.listTools()).toEqual([]);
  });
  it("rejects duplicate in-progress connection attempts without spawning twice",async()=>{
    const results=await Promise.allSettled([hub.connectStdio(config("slow-start")),hub.connectStdio(config("slow-start"))]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(fs.readFileSync(path.join(root,"starts"),"utf8").trim().split("\n")).toHaveLength(1);
  });
  it("shuts down an initialization that is still pending",async()=>{
    const connecting=hub.connectStdio(config("no-init"));const settled=connecting.catch(e=>e);
    await until(()=>fs.existsSync(path.join(root,"pid")));await hub.shutdown();expect(await settled).toBeInstanceOf(Error);expect(alive(pid())).toBe(false);
  });
  it("bounds concurrent requests instead of queueing unbounded work",async()=>{
    await hub.connectStdio(config("normal",{maxConcurrentRequests:1,requestTimeoutMs:1000}));const first=hub.callPrefixedTool("mcp__peer__delay",{count:150});
    await expect(hub.callPrefixedTool("mcp__peer__echo",{})).rejects.toThrow("concurrent");await expect(first).resolves.toBe("ok");
  });
  it("joins process-group cleanup including SIGTERM-resistant descendants",async()=>{
    await hub.connectStdio(config("stubborn"));const parent=pid(),child=Number(fs.readFileSync(path.join(root,"child"),"utf8"));await delay(80);
    await hub.disconnect("peer");await until(()=>!alive(parent)&&!alive(child));expect(hub.listServers()).toEqual([]);
  });
  it("cleans descendants when their parent exits normally",async()=>{
    await hub.connectStdio(config("stubborn"));const child=Number(fs.readFileSync(path.join(root,"child"),"utf8"));await delay(80);
    await expect(hub.callPrefixedTool("mcp__peer__exit",{})).rejects.toThrow();await until(()=>!alive(child));
  });
  it("validates tool metadata atomically and preserves original tool names",async()=>{
    await expect(hub.connectStdio(config("collision"))).rejects.toThrow("collision");expect(hub.listTools()).toEqual([]);
    await hub.disconnect("peer");await hub.connectStdio(config("original-name"));await expect(hub.callPrefixedTool("mcp__peer__echo_words",{})).resolves.toBe("echo words");
  });
  it("rejects reserved local server names and excessive tool discovery",async()=>{
    await expect(hub.connectStdio({...config(),name:"local"})).rejects.toThrow("reserved");
    await expect(hub.connectStdio(config("too-many-tools"))).rejects.toThrow("count limit");expect(hub.listTools()).toEqual([]);
  });
  it("rejects excessive tool metadata and unsupported configuration limits",async()=>{
    await expect(hub.connectStdio(config("large-metadata",{maxToolMetadataBytes:4096}))).rejects.toThrow("metadata");
    expect(()=>resolveMcpLimits({requestTimeoutMs:0})).toThrow();expect(()=>resolveMcpLimits({maxJsonDepth:10000})).toThrow();expect(()=>resolveMcpLimits({unknown:1})).toThrow();
  });
  it("sanitizes terminal controls and bounds output before runtime persistence",async()=>{
    await hub.connectStdio(config("normal",{maxToolOutputBytes:1024}));const result=await hub.callPrefixedTool("mcp__peer__big",{count:1000});
    expect(result).not.toMatch(/[\x00\x1b]/);expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024);expect(result).toContain("truncated");expect(result).not.toContain("�");
    expect(cleanMcpText("before\x1b]52;c;evil\x07after\x00")).toBe("beforeafter");
  });
  it("rotates a bounded output quota without growing generic tool-results",async()=>{
    const output="x".repeat(10000);for(let i=0;i<4;i++)expect(await finalizeMcpToolOutput(output,{root,quotaBytes:21000,quotaFiles:2})).toContain("Full output:");
    const directory=path.join(root,".agent/mcp/results");const files=fs.readdirSync(directory).filter(f=>f.endsWith(".txt"));expect(files).toHaveLength(2);expect(files.reduce((n,f)=>n+fs.statSync(path.join(directory,f)).size,0)).toBe(20000);
    expect(fs.existsSync(path.join(root,".agent/tool-results"))).toBe(false);
    expect(await finalizeMcpToolOutput(output,{root,quotaBytes:100,quotaFiles:2})).toContain("not saved");
  });
  it("uses typed timeout/cancellation results through the real ToolRuntime",async()=>{
    await hub.connectStdio(config());await runWithAgentContext(createAgentContext({role:"lead"}),()=>runWithWorkdir(root,async()=>{
      const call={function:{name:"mcp__peer__hang",arguments:"{}"}};expect((await executeToolCallResult(call)).status).toBe("timeout");
      const controller=new AbortController();const pending=executeToolCallResult(call,undefined,{signal:controller.signal});setTimeout(()=>controller.abort(),20);expect((await pending).status).toBe("cancelled");
    }));
  });
  it("registers MCP management tools but denies non-lead roles",async()=>{
    expect(getOpenaiTools(false).map(t=>t.function.name)).toEqual(expect.arrayContaining(["connect_mcp","disconnect_mcp","restart_mcp","list_mcp_servers"]));
    for(const role of ["worker","subagent","teammate"] as const)await runWithAgentContext(createAgentContext({role}),async()=>{
      expect((await executeToolCallResult({function:{name:"connect_mcp",arguments:'{"name":"peer"}'}})).status).toBe("error");
    });
  });
  it("requires matching trust for configured launches and supports explicit restart",async()=>{
    await expect(hub.connectConfigured("peer")).rejects.toThrow("trust");await configured(config());await hub.connectConfigured("peer");await hub.restartConfigured("peer");expect(hub.listServers()).toEqual(["peer"]);
    fs.appendFileSync(path.join(root,".agent/mcp.json")," ");await hub.disconnect("peer");await expect(hub.connectConfigured("peer")).rejects.toThrow("trust");
  });
  it("restarts only within an opted-in budget and never replays failed calls",async()=>{
    const cfg={...config(),autoRestart:true,limits:{...config().limits,maxRestarts:1}};await configured(cfg);await hub.connectConfigured("peer");
    await expect(hub.callPrefixedTool("mcp__peer__exit",{})).rejects.toThrow();await until(()=>hub.listServers().length===1);
    expect(hub.listServerStatus()[0].restarts).toBe(1);expect(fs.readFileSync(path.join(root,"calls"),"utf8").trim()).toBe("exit");
    await expect(hub.callPrefixedTool("mcp__peer__exit",{})).rejects.toThrow();await delay(150);expect(hub.listServers()).toEqual([]);expect(fs.readFileSync(path.join(root,"starts"),"utf8").trim().split("\n")).toHaveLength(2);
  });
  it("blocks automatic restarts after trust changes",async()=>{
    const cfg={...config(),autoRestart:true,limits:{...config().limits,cooldownMs:100}};await configured(cfg);await hub.connectConfigured("peer");await expect(hub.callPrefixedTool("mcp__peer__exit",{})).rejects.toThrow();
    fs.appendFileSync(path.join(root,".agent/mcp.json")," ");await delay(200);expect(hub.listServers()).toEqual([]);expect(hub.listServerStatus()[0].restarts).toBe(0);
  });
  it("connects configuration before work and always closes on thrown errors",async()=>{
    await configured({...config(),autoConnect:true});await expect(withMcpLifecycle(async()=>{expect(hub.listServers()).toEqual(["peer"]);throw new Error("work failed");},hub)).rejects.toThrow("work failed");expect(alive(pid())).toBe(false);expect(hub.listTools()).toEqual([]);
  });
  it("rejects malformed and oversized configuration before spawning",()=>{
    fs.mkdirSync(path.join(root,".agent"),{recursive:true});const file=path.join(root,".agent/mcp.json");fs.writeFileSync(file,JSON.stringify({mcpServers:{peer:null}}));expect(()=>loadMcpConfig(file,root)).toThrow("must be an object");
    fs.writeFileSync(file,JSON.stringify({mcpServers:{peer:{command:process.execPath,autoConnect:"false"}}}));expect(()=>loadMcpConfig(file,root)).toThrow("must be boolean");
    fs.writeFileSync(file,'{"mcpServers":{"__proto__":{"command":"node"}}}');const parsed=loadMcpConfig(file,root);expect(Object.getPrototypeOf(parsed)).toBeNull();expect(Object.hasOwn(parsed,"__proto__")).toBe(true);expect(parsed.constructor).toBeUndefined();
    expect(()=>resolveMcpLimits({constructor:1})).toThrow("Unknown MCP limit");
    fs.writeFileSync(file," ".repeat(300000));expect(()=>loadMcpConfig(file,root)).toThrow("256 KiB");
  });
  it("handles a peer that stops reading stdin without hanging close",async()=>{
    const transport=new ManagedStdioTransport({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],env:{},cwd:root},resolveMcpLimits({shutdownGraceMs:20,maxFrameBytes:1024*1024}));
    await transport.start();const child=transport.pid!;const pending=transport.send({jsonrpc:"2.0",id:1,method:"test",params:{data:"x".repeat(800000)}}).catch(e=>e);
    await delay(20);await transport.close();expect(await pending).toBeInstanceOf(Error);await until(()=>!alive(child));
  });
  it("preserves advertised output schema validation",async()=>{
    await hub.connectStdio(config("schema"));expect(await hub.callPrefixedTool("mcp__peer__echo",{count:7})).toBe("validated");
    await expect(hub.callPrefixedTool("mcp__peer__echo",{count:"wrong"})).rejects.toThrow("schema");
  });
  it("bounds error wrappers including escaped text",()=>{
    const output=MCPHub.formatCallResult({isError:true,content:[{type:"text",text:'\\"\n'.repeat(20000)}]},1024);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1024);expect(JSON.parse(output)).toMatchObject({status:"error"});
  });
  it("bounds stdout byte rate independently of per-frame size",async()=>{
    await hub.connectStdio(config("normal",{maxStdoutBytesPerSecond:4096}));await expect(hub.callPrefixedTool("mcp__peer__overflow",{count:8192})).rejects.toThrow();
    expect(hub.listServerStatus()[0].lastError).toContain("stdout rate");
  });
  it("does not restart an explicitly cancelled initialization",async()=>{
    const cfg={...config("no-init"),autoRestart:true};await configured(cfg);const controller=new AbortController();const starting=hub.connectConfigured("peer",controller.signal);const outcome=starting.catch(e=>e);
    await until(()=>fs.existsSync(path.join(root,"pid")));controller.abort();expect(await outcome).toMatchObject({status:"cancelled"});await delay(150);
    expect(hub.listServerStatus()[0].status).toBe("closed");expect(fs.readFileSync(path.join(root,"starts"),"utf8").trim().split("\n")).toHaveLength(1);
  });
  it("redacts configured secrets from bounded stderr diagnostics",async()=>{
    const cfg={...config(),args:["-e","console.error(process.env.TEST_SECRET);"+MCP_FIXTURE_SOURCE],env:{...config().env,TEST_SECRET:"fixture-secret-12345"}};
    await hub.connectStdio(cfg);await until(()=>String(hub.listServerStatus()[0].stderrTail).includes("[redacted]"));expect(JSON.stringify(hub.listServerStatus())).not.toContain("fixture-secret-12345");
  });
  it("supports a Python stdio peer with the same lifecycle",async()=>{
    const python=path.join(root,"server.py");fs.writeFileSync(python,`import sys,json,os\nopen(os.environ['PID_FILE'],'w').write(str(os.getpid()))\nfor line in sys.stdin:\n m=json.loads(line)\n if m.get('method')=='initialize': r={'protocolVersion':m['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'python','version':'1'}}\n elif m.get('method')=='tools/list': r={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]}\n elif m.get('method')=='tools/call': r={'content':[{'type':'text','text':'python-ok'}]}\n else: continue\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)\n`);
    await hub.connectStdio({...config(),command:"python3",args:["-u",python]});const processId=pid();expect(await hub.callPrefixedTool("mcp__peer__echo",{})).toBe("python-ok");await hub.disconnect("peer");expect(alive(processId)).toBe(false);
  });
  it("does not accumulate cancellation listeners on a long-lived turn signal",async()=>{
    await hub.connectStdio(config());const controller=new AbortController();
    for(let i=0;i<30;i++)expect(await hub.callPrefixedTool("mcp__peer__echo",{},controller.signal)).toBe("echo");
    expect(getEventListeners(controller.signal,"abort")).toHaveLength(0);controller.abort();expect(hub.listServers()).toEqual(["peer"]);
  });
  it("does not count intentional disconnects as peer health failures",async()=>{
    await hub.connectStdio(config());const pending=hub.callPrefixedTool("mcp__peer__hang",{}).catch(e=>e);
    await hub.disconnect("peer");expect(await pending).toBeInstanceOf(McpCallError);expect(hub.listServerStatus()[0]).toMatchObject({status:"closed",consecutiveFailures:0});
  });
});
