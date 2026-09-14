// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright module.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage(); const errors = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/(status|send|respond|stop|run\/|awf\/)/.test(new URL(request.url()).pathname)) apiRequests.push(request.url()); });
    const go = async (view, scenario = 'demo') => { await page.goto(`http://127.0.0.1:5174/?view=${view}&scenario=${scenario}`); await page.locator('.preview-controls').waitFor(); await page.locator('.project-item.selected').waitFor({state:'attached'}); await page.waitForTimeout(350); };
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['run','tasks','decisions','reviews','logs']) {
        await go(view);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${view} overflow at ${width}`);
        assert.equal(await page.getByRole('alert').count(), 0, `${view} errors at ${width}`);
      }
    }
    await page.setViewportSize({width:1440,height:900});
    await go('run'); await page.getByRole('button',{name:'暂停调度',exact:true}).click(); await page.getByRole('button',{name:'恢复运行',exact:true}).waitFor();
    await page.getByLabel('消息',{exact:true}).fill('请验证模拟消息'); await page.getByRole('button',{name:'发送',exact:true}).click(); await page.getByText('你：请验证模拟消息',{exact:false}).waitFor();
    await go('run','waiting'); await page.getByRole('button',{name:'检查原因后重试',exact:true}).click(); await page.waitForFunction(()=>!document.querySelector('.pending-card'));
    await go('run','idle'); await page.getByRole('button',{name:'启动 Run',exact:true}).click(); await page.getByRole('button',{name:'暂停调度',exact:true}).waitFor();
    await go('reviews'); const approve=page.getByRole('button',{name:'批准并应用',exact:true}); assert.equal(await approve.isDisabled(),true); await page.getByLabel('复审人',{exact:true}).fill('浏览器验证'); await approve.click(); await page.waitForFunction(()=>document.querySelector('.detail-pane')?.textContent.includes('已应用'));
    await go('decisions'); await page.getByLabel('复审说明',{exact:true}).fill('增加边界验证'); await page.getByRole('button',{name:'提交其他决策',exact:true}).click(); await page.waitForFunction(()=>document.querySelector('.detail-pane')?.textContent.includes('已调整'));
    await go('logs'); await page.getByRole('button',{name:'清屏',exact:true}).click();
    await page.getByLabel('预览主题').selectOption('light'); assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    await go('run'); await page.getByRole('button',{name:'任务',exact:true}).click(); await page.waitForURL('**view=tasks**'); await page.goBack(); await page.waitForURL('**view=run**');
    await go('tasks','empty'); assert.equal(await page.locator('.record-card').count(),0);
    await go('run','error'); await page.getByRole('alert').first().waitFor();
    assert.deepEqual(errors,[]); assert.deepEqual(apiRequests,[],'mock must never issue real API requests');
    console.log('PASS: 5 pages × 4 widths; pause/send/respond/start/approve/override/clear/theme/empty/error; zero live API requests');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
