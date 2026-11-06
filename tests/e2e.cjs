'use strict';
// Real Chromium DOM / Fullscreen API with a test-only runtime in an ISOLATED world.
// Does not install the extension or contact Brave. See extension-smoke.cjs.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {start} = require('./server.cjs');
const root = path.resolve(__dirname, '..');
const WORLD = 'fws-test-isolated';
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const sources = ['shared.js', 'content.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const bootstrap = `if (location.hostname === 'localhost') {
  const listeners = new Set();
  globalThis.__harness = {originalRequestFullscreen:Element.prototype.requestFullscreen,originalExitFullscreen:Document.prototype.exitFullscreen,originalPushState:history.pushState,searches:0,reports:[],missingKey:true,listeners,pending:new Map()};
  globalThis.__harnessDispatch = message => {
    let result; for (const listener of [...listeners]) listener(message, {}, response => {result=response;}); return result;
  };
  globalThis.chrome = {runtime:{
    onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
    sendMessage:async message=>{
      if(message.type==='FWS_BOOT') return {ok:true,css:${JSON.stringify(css)}};
      if(message.type==='FWS_REPORT') {__harness.reports.push(message.error);return {ok:true};}
      if(message.type==='FWS_CANCEL') {__harness.pending.get(message.requestId)?.(); return {ok:true};}
      if(message.type==='FWS_OPTIONS') return {ok:true};
      if(message.type==='FWS_SEARCH') {
        __harness.searches++;
        if(__harness.missingKey) return {ok:false,error:'APIキーが未設定です。'};
        if(message.query==='error') return {ok:false,error:'テスト用APIエラー。再試行してください。'};
        if(message.query==='slow') await new Promise(resolve=>{
          const timer=setTimeout(()=>{__harness.pending.delete(message.requestId);resolve();},150);
          __harness.pending.set(message.requestId,()=>{clearTimeout(timer);__harness.pending.delete(message.requestId);resolve();});
        });
        return {ok:true,more:message.page<2,results:Array.from({length:12},(_,i)=>({
          title:'日本語 結果 '+message.page+'-'+i+' <img src=x onerror=alert(1)>',
          url:i===0?'javascript:alert(1)':'https://example.org/'+message.page+'/'+i,
          description:'安全な概要 <script>alert(1)</script> '+message.query
        }))};
      }
      return {ok:false};
    }
  }};
  ${sources}
}`;
(async () => {
  const server = await start(8787);
  let browser;
  const checks = [], errors = [];
  try {
    browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
    const context = await browser.newContext({viewport:{width:1200,height:850},reducedMotion:'reduce'});
    const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    cdp.on('Runtime.exceptionThrown',({exceptionDetails:d})=>errors.push(d.exception?.description||d.text));
    await cdp.send('Runtime.enable'); await page.goto('http://localhost:8787/');
    const run = async expression => {
      const frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
      const id = (await cdp.send('Page.createIsolatedWorld',{frameId,worldName:WORLD})).executionContextId;
      const init = await cdp.send('Runtime.evaluate',{expression:'typeof __harness',contextId:id,returnByValue:true});
      if(init.result.value==='undefined') {
        const boot = await cdp.send('Runtime.evaluate',{expression:bootstrap,contextId:id,awaitPromise:true});
        if(boot.exceptionDetails) throw new Error(boot.exceptionDetails.exception?.description||boot.exceptionDetails.text);
      }
      const r=await cdp.send('Runtime.evaluate',{expression,contextId:id,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
      return r.result.value;
    };
    const dispatch=type=>run(`__harnessDispatch({type:${JSON.stringify(type)}})`);
    const host=()=>page.locator('[data-fullscreen-web-search="panel"]');
    const input=()=>host().locator('input');
    const open=async()=>{const reply=await dispatch('FWS_TOGGLE');assert.equal(reply?.ok,true,JSON.stringify(reply));await host().waitFor({state:'visible'});};
    const close=async()=>{await host().getByRole('button',{name:'検索パネルを閉じる',exact:true}).click();await host().waitFor({state:'detached'});};
    const query=async text=>{await input().fill(text);await host().getByRole('button',{name:'検索',exact:true}).click();};
    async function check(name,fn){await fn();checks.push(name);console.log(`PASS ${name}`);}
    await page.waitForFunction(()=>document.readyState==='complete');
    await check('通常ページ：body内、Shadow DOM、入力フォーカス',async()=>{
      await open();assert.equal(await host().evaluate(el=>el.parentNode===document.body),true);
      assert.equal(await host().evaluate(el=>el.shadowRoot.activeElement?.localName),'input');
      assert.equal(await host().evaluate(el=>el.matches(':popover-open')),true);
    });
    await check('APIキー未設定の案内',async()=>{await query('日本語');await host().getByRole('status').filter({hasText:'APIキーが未設定'}).waitFor();});
    await run('__harness.missingKey=false');
    await check('日本語検索、10件上限、安全なテキスト描画・URL検証',async()=>{
      await query('日本語');await host().locator('.result').first().waitFor();
      assert.equal(await host().locator('.result').count(),9);
      assert.equal(await host().locator('img,script').count(),0);
      assert.match(await host().locator('h3').first().textContent(),/<img/);
      assert.equal(await host().locator('a').first().getAttribute('rel'),'noopener noreferrer');
      assert.match(await host().locator('footer').textContent(),/全画面表示が解除/);
    });
    await check('ページ送りと前ページへの復帰',async()=>{
      await host().getByRole('button',{name:'次へ →',exact:true}).click();await host().locator('h3').filter({hasText:'結果 1-1'}).waitFor();
      await host().getByRole('button',{name:'← 前へ',exact:true}).click();await host().locator('h3').filter({hasText:'結果 0-1'}).waitFor();
    });
    await check('URLコピーまたはキーボード用フォールバック',async()=>{
      await host().locator('.copy').first().click();
      await page.waitForFunction(()=>{const r=document.querySelector('[data-fullscreen-web-search]').shadowRoot;return r.querySelector('.copy').textContent==='コピー済み'||!!r.querySelector('textarea');});
    });
    await check('APIエラー後に再検索できる',async()=>{
      await query('error');await host().getByRole('status').filter({hasText:'テスト用APIエラー'}).waitFor();
      await query('復旧');await host().locator('.result').first().waitFor();
    });
    await check('読み込み表示と新しい検索による古い応答の無効化',async()=>{
      await query('slow');assert.equal(await host().locator('.spinner').isVisible(),true);
      await query('最新');await host().locator('.description').filter({hasText:'最新'}).first().waitFor();
      assert.equal(await host().locator('.description').filter({hasText:'slow'}).count(),0);
    });
    await check('Tabフォーカス循環、Escapeで閉じる、再表示で入力を消去',async()=>{
      await host().getByRole('button',{name:'設定 / APIキー',exact:true}).focus();await page.keyboard.press('Tab');
      assert.equal(await host().evaluate(el=>el.shadowRoot.activeElement?.className),'close');
      await page.keyboard.press('Escape');await host().waitFor({state:'detached'});
      await open();assert.equal(await input().inputValue(),'');await close();
    });
    await check('繰り返し開閉20回でもリスナー・検索送信が重複しない',async()=>{
      for(let i=0;i<20;i++){await open();await dispatch('FWS_TOGGLE');}
      assert.equal(await run('__harness.listeners.size'),1);
      await open();const before=await run('__harness.searches');await query('単一送信');
      await host().locator('.result').first().waitFor();assert.equal(await run('__harness.searches'),before+1);await close();
    });
    await check('Fullscreen API中に開き、全画面要素の子孫へ配置',async()=>{
      await page.locator('#fullscreen').click();await page.waitForFunction(()=>!!document.fullscreenElement);
      await open();assert.equal(await host().evaluate(el=>el.parentNode===document.fullscreenElement),true);
      const box=await host().boundingBox();assert.ok(box.width>=400&&box.width<=500);
      assert.equal(await host().evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.right-20,r.top+40)===el;}),true);
    });
    if(process.env.FWS_SCREENSHOT){await query('フルスクリーン 検索');await host().locator('.result').first().waitFor();await page.screenshot({path:process.env.FWS_SCREENSHOT});}
    await check('パネルを閉じてもFullscreen APIが維持される',async()=>{await close();assert.equal(await page.evaluate(()=>document.fullscreenElement?.id),'stage');});
    await check('全画面要素内のDOM再生成後に安全に再配置',async()=>{
      await open();await page.evaluate(()=>document.fullscreenElement.replaceChildren(document.createElement('h2')));
      await host().waitFor({state:'visible'});assert.equal(await host().count(),1);
      assert.equal(await host().evaluate(el=>el.parentNode===document.fullscreenElement),true);
    });
    await check('fullscreenchangeによるbodyへの移動と全画面への再配置',async()=>{
      await page.evaluate(()=>document.exitFullscreen());
      await page.waitForFunction(()=>document.querySelector('[data-fullscreen-web-search]')?.parentNode===document.body);
      await page.locator('#fullscreen').click();
      await page.waitForFunction(()=>document.querySelector('[data-fullscreen-web-search]')?.parentNode===document.fullscreenElement);
      await close();await page.evaluate(()=>document.exitFullscreen());
    });
    await check('Open Shadow DOM内の全画面要素へ配置',async()=>{
      await page.locator('#open-shadow').click();await open();
      assert.equal(await host().evaluate(el=>el.parentNode===document.fullscreenElement.shadowRoot.fullscreenElement),true);
      await close();await page.evaluate(()=>document.exitFullscreen());
    });
    await check('video要素の全画面では理由を返し全画面を維持',async()=>{
      await page.locator('#video-fullscreen').click();const reply=await dispatch('FWS_TOGGLE');
      assert.equal(reply.ok,false);assert.match(reply.error,/video/);assert.equal(await page.evaluate(()=>document.fullscreenElement?.localName),'video');
      await page.evaluate(()=>document.exitFullscreen());
    });
    await check('SPA遷移通知で旧UIを閉じ、次の表示が正常',async()=>{
      await open();await page.locator('#spa').click({force:true});await dispatch('FWS_ROUTE_CHANGED');
      await host().waitFor({state:'detached'});await open();await close();
    });
    await check('通常ページ遷移後の再初期化',async()=>{await page.goto('http://localhost:8787/second.html');await open();await close();});
    await check('再読み込み後の再初期化',async()=>{await page.reload();await open();await close();});
    await check('body置換後の再配置',async()=>{
      await open();await page.evaluate(()=>document.body.replaceWith(document.createElement('body')));
      await host().waitFor({state:'visible'});assert.equal(await host().evaluate(el=>el.parentNode===document.body),true);await close();
    });
    await check('小さい画面でのレスポンシブ表示',async()=>{
      await page.setViewportSize({width:360,height:640});await open();const box=await host().boundingBox();assert.equal(box.width,360);await close();
    });
    await check('同一ドキュメントへの再注入でも単一インスタンス',async()=>{
      await run(sources);assert.equal(await run('__harness.listeners.size'),1);await open();await close();
    });
    await check('ページのFullscreen APIとHistory APIを上書きしない',async()=>{
      assert.equal(await run('Element.prototype.requestFullscreen===__harness.originalRequestFullscreen&&Document.prototype.exitFullscreen===__harness.originalExitFullscreen&&history.pushState===__harness.originalPushState'),true);
    });
    await check('inertなページではフォーカス失敗の理由を返す',async()=>{
      await page.evaluate(()=>{document.body.inert=true;});const reply=await dispatch('FWS_TOGGLE');assert.equal(reply.ok,false);assert.match(reply.error,/フォーカス/);
      await page.evaluate(()=>{document.body.inert=false;});
    });
    await check('ページがUIを繰り返し削除する場合は再配置を打ち切る',async()=>{
      await page.evaluate(()=>{
        window.__fwsKiller=new MutationObserver(records=>{for(const r of records)for(const el of r.addedNodes)if(el.nodeType===1&&el.hasAttribute('data-fullscreen-web-search'))el.remove();});
        window.__fwsKiller.observe(document.body,{childList:true});
      });
      await dispatch('FWS_TOGGLE');
      for(let i=0;i<20;i++){if((await run('__harness.reports')).some(s=>s.includes('繰り返し削除')))break;await page.waitForTimeout(10);}
      assert.equal((await run('__harness.reports')).some(s=>s.includes('繰り返し削除')),true);
      assert.equal(await host().count(),0);await page.evaluate(()=>window.__fwsKiller.disconnect());
    });
    await check('許可解除時にUIとメッセージリスナーを破棄',async()=>{
      await open();await dispatch('FWS_DISABLE');await host().waitFor({state:'detached'});
      assert.equal(await run('__harness.listeners.size'),0);assert.equal(await run('typeof globalThis.__fullscreenWebSearchV1'),'undefined');
    });
    assert.deepEqual(errors,[]);
    console.log(`\n${checks.length} browser checks passed; Chromium ${browser.version()}; isolated runtime MOCK; no Brave traffic.`);
    if(process.env.FWS_REPORT)fs.writeFileSync(process.env.FWS_REPORT,JSON.stringify({browser:browser.version(),checks,errors,runtime:'MOCK / CDP isolated world',brave:'not called'},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
