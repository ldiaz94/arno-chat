const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const html=require('node:child_process').execFileSync('curl',['-fsSL','--max-time','30','https://arno-compat-probe.lucelad.workers.dev/'],{encoding:'utf8'});
 await page.route('https://arno-compat-probe.lucelad.workers.dev/',route=>route.fulfill({contentType:'text/html',body:html}));
 let pages=[],submitted=null;
 await page.route('**/api/**',async route=>{
  const u=new URL(route.request().url());let d;
  if(u.pathname==='/api/me')d={user:{login:'test'}};
  else if(u.pathname.endsWith('/messages')){submitted=route.request().postDataJSON();await route.abort('failed');return}
  else if(u.pathname.endsWith('/job'))d=submitted?{id:submitted.id,status:'completed',result:{model:'m',summary:'Recovered after lost response'}}:{status:'idle'};
  else if(u.pathname==='/api/models')d={models:[{id:'m',name:'Model M'},{id:'gpt-oss:120b',name:'GPT OSS 120B'}]};
  else if(u.pathname.endsWith('/model'))d={model:'gpt-oss:120b'};
  else if(u.pathname==='/api/sessions')d={sessions:[{id:'11111111-1111-1111-1111-111111111111',repo:'test/saved'}]};
  else if(u.pathname.startsWith('/api/sessions/'))d={repo:'test/saved',model:'m',history:[{prompt:'hello',summary:'x'.repeat(1000),diff:'y'.repeat(1000)}]};
  else {const n=Number(u.searchParams.get('page'));pages.push(n);d={repos:n===2?[{full_name:'test/target',private:true,default_branch:'main'}]:[],nextPage:n===1?2:null};}
  await route.fulfill({json:d});
 });
 await page.goto('https://arno-compat-probe.lucelad.workers.dev/');
 await page.getByPlaceholder('Search all accessible repositories').fill('target');
 await page.getByText('test/target').waitFor();
 if(!pages.includes(2))throw Error('Did not search beyond page 1');
 await page.getByRole('button',{name:'test/saved'}).click();
 await page.locator('#composer').waitFor({state:'visible'});
 await page.getByLabel('Session model').selectOption('gpt-oss:120b');
 await page.waitForFunction(()=>!document.querySelector('#session-model').disabled);
 await page.getByLabel('Message',{exact:true}).fill('Explain the repo');
 await page.getByRole('button',{name:'Run',exact:true}).click();
 await page.getByText('Recovered after lost response',{exact:false}).waitFor();
 for(const size of [{width:390,height:844},{width:390,height:380},{width:844,height:390}]){
  await page.setViewportSize(size);
  const dims=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,shell:document.querySelector('#shell').getBoundingClientRect().height}));
  if(dims.scroll>dims.width)throw Error('Horizontal overflow');
 }
 await page.reload();await page.locator('#composer').waitFor({state:'visible'});
 if(errors.length)throw Error(errors.join('\n'));
 console.log('Browser: paginated search, saved session reopen, reload, portrait/landscape and reduced keyboard viewport passed');
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
