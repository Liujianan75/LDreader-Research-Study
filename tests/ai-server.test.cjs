'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { createServer, validateAIInput, buildMessages, readSSE, requestAI } = require('../server.cjs');
const config = { configured:true, provider:'siliconflow', apiKey:'test-secret-only', model:'test-model', endpoint:'https://example.invalid/chat/completions', maxTokens:128, temperature:0.4, timeoutMs:2000, enableThinking:false };
const input = { kind:'explain', quote:'人力车', context:'雨天，车夫仍在拉人力车。', title:'测试作品', author:'测试作者', language:'zh-CN', outputLanguage:'zh-CN' };
const fixture = 'data: {"model":"test-model","choices":[{"delta":{"reasoning_content":"不应显示"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"人力车："}}]}\n\ndata: {"choices":[{"delta":{"content":"依靠人力拉动的车。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function fakeResponse(text=fixture) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller){ for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close(); } }), {headers:{'content-type':'text/event-stream'}});
}
test('打包模块不依赖 __dirname，也不会触发独立 CLI 监听',()=>{
  const bundledModule={exports:{}};
  const bundledRequire=id=>require(id);
  Object.defineProperty(bundledRequire,'main',{get(){throw new Error('打包模块不得读取 CLI require.main');}});
  vm.runInNewContext(readFileSync(require.resolve('../server.cjs'),'utf8'),{module:bundledModule,require:bundledRequire,process:{cwd:()=>'/fixture-bundle',env:{}},fetch,URL,TextDecoder,AbortController,Buffer,setTimeout,clearTimeout,console});
  assert.equal(typeof bundledModule.exports.createServer,'function');
});
test('流式分块、中文 UTF-8、多 data 行和思考内容过滤', async()=>{
  const events=[];await readSSE(new Response('data: first\r\ndata: second\r\n\r\n').body,data=>events.push(data));assert.deepEqual(events,['first\nsecond']);
  let content='', sent;
  const result=await requestAI(config,validateAIInput(input),{onText:text=>content+=text,fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);assert.equal(options.headers.Authorization,'Bearer test-secret-only');return fakeResponse();}});
  assert.equal(content,'人力车：依靠人力拉动的车。');assert(!content.includes('不应显示'));assert.equal(result.model,'test-model');assert.equal(sent.stream,true);assert.equal(sent.enable_thinking,false);assert(!JSON.stringify(sent).includes(config.apiKey));
});
test('选词约束、知识检索提示、服务错误和流中断',async()=>{
  assert.throws(()=>validateAIInput({...input,kind:'other'}));assert.throws(()=>validateAIInput({...input,quote:'x'.repeat(2001)}));
  assert(buildMessages({...input,kind:'search'})[0].content.includes('当前没有联网搜索工具'));
  await assert.rejects(requestAI(config,input,{onText(){},fetchImpl:async()=>new Response('secret upstream error',{status:401})}),/认证失败/);
  await assert.rejects(requestAI(config,input,{onText(){},fetchImpl:async()=>fakeResponse(fixture.replace('data: [DONE]\n\n',''))}),/提前中断/);
});
test('jdweb 语境风格、完整材料、译名表与位置进入提示词',()=>{
  const full={...input,context:'原文与译文\n'.repeat(3000),contextScope:'full-material-bilingual-v1',nameGlossary:'김 첨지 → 金佥知（不用金签知）',selectedParagraphIds:['ko-14'],materialVersion:'docx-context-v5'};
  const validated=validateAIInput(full),messages=buildMessages(validated),data=JSON.parse(messages[1].content);
  assert.equal(data.完整阅读材料,full.context);assert.equal(data.本文译名表,full.nameGlossary);assert.deepEqual(data.选中段落,['ko-14']);
  for(const phrase of ['通俗易懂、生动形象','完整阅读','不得另造中文译名','醉话','类比'])assert(messages[0].content.includes(phrase));
  assert.throws(()=>validateAIInput({...full,context:'x'.repeat(48001)}));assert.throws(()=>validateAIInput({...full,selectedParagraphIds:['<script>']}));assert.throws(()=>validateAIInput({...full,nameGlossary:{}}));
});
test('本机代理端到端、密钥隔离、来源限制与输入错误',async(t)=>{
  let calls=0;
  const server=createServer({configLoader:async()=>config,fetchImpl:async()=>{calls++;return fakeResponse();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const status=await(await fetch(base+'/api/ai/status')).text();assert(!status.includes(config.apiKey));assert.equal(JSON.parse(status).model,'test-model');
  assert.equal((await fetch(base+'/.ldreader-ai.json')).status,404);assert.equal((await fetch(base+'/%2eldreader-ai.json')).status,404);assert.equal((await fetch(base+'/server.cjs')).status,404);assert.equal((await fetch(base+'/LDreader_experiment.html')).status,200);
  const rejected=await fetch(base+'/api/ai',{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body:JSON.stringify(input)});assert.equal(rejected.status,403);assert.equal(calls,0);
  const invalid=await fetch(base+'/api/ai',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({...input,quote:''})});assert.equal(invalid.status,400);
  const response=await fetch(base+'/api/ai',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(input)}),body=await response.text();assert(body.includes('event: done'));assert(body.includes('人力车：'));assert(!body.includes(config.apiKey));assert.equal(calls,1);
});
test('超时取消上游请求，返回可重试状态',async(t)=>{
  let aborted=false;
  const server=createServer({configLoader:async()=>({...config,timeoutMs:30}),fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,response=await fetch(base+'/api/ai',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(input)});
  const body=await response.text();assert(aborted);assert(body.includes('event: error'));assert(body.includes('超时'));assert(!body.includes('event: done'));
});
test('管理员密码在本机校验，拒绝错误密码和跨站请求',async(t)=>{
  const server=createServer({adminPassword:'admin-fixture-only',configLoader:async()=>config});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const verify=(password,origin=base)=>fetch(base+'/api/admin/verify',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})});
  assert.equal((await verify('wrong')).status,401);assert.equal((await verify('')).status,400);assert.equal((await verify('admin-fixture-only','https://other.invalid')).status,403);
  const valid=await verify('admin-fixture-only');assert.equal(valid.status,200);assert.deepEqual(await valid.json(),{authorized:true});
  const html=await(await fetch(base+'/LDreader_experiment.html')).text();assert(!html.includes('admin-fixture-only'));assert(!html.includes("'ljn'"));
});
test('同站点托管显式 HTTPS 来源，拒绝伪造 Host 和其他 Origin',async(t)=>{
  assert.throws(()=>createServer({publicOrigin:'http://study.invalid'}));
  assert.throws(()=>createServer({publicOrigin:'https://study.invalid/path'}));
  const server=createServer({publicOrigin:'https://study.invalid',adminPassword:'hosted-fixture-only',configLoader:async()=>config,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'本机模拟解释'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  // Node fetch 会重写 Host，使用 http.request 覆盖真实公网反代的 Host。
  const request=(host,origin,pathname='/api/ai',body=input)=>new Promise((resolve,reject)=>{
    const req=http.request(base+pathname,{method:'POST',headers:{host,...(origin?{origin}:{}),'content-type':'application/json'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode})));});
    req.on('error',reject);req.end(JSON.stringify(body));
  });
  assert.equal((await request('evil.invalid','https://study.invalid')).status,403);
  assert.equal((await request('study.invalid','https://evil.invalid')).status,403);
  assert.equal((await request('study.invalid',null)).status,403);
  const response=await request('study.invalid','https://study.invalid');assert.equal(response.status,200);assert((await response.text()).includes('event: done'));
  const admin=await request('study.invalid','https://study.invalid','/api/admin/verify',{password:'hosted-fixture-only'});assert.equal(admin.status,200);
});
