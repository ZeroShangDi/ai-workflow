// PLAYWRIGHT_MODULE points to an installed Playwright package; tests never contact the backend.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage(); const errors = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^\/(status|send|respond|stop|run\/|awf\/|workspace|conversation|projects\/|requirements|plan\/|logs\/source)/.test(new URL(request.url()).pathname)) apiRequests.push(request.url()); });
    const button = name => page.getByRole('button', { name, exact: true });
    const go = async (view, scenario = 'demo') => { await page.goto(`http://127.0.0.1:5174/?view=${view}&scenario=${scenario}`); await page.locator('.preview-controls').waitFor(); if (scenario !== 'empty') await page.locator('.project-item.selected').waitFor({ state: 'attached' }); await page.waitForTimeout(450); };
    const tick = async (n = 1) => { for (let i = 0; i < n; i++) await button('推进状态').click(); await page.waitForTimeout(1800); };
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['project', 'plan', 'run', 'tasks', 'decisions', 'reviews', 'logs']) {
        await go(view, view === 'plan' ? 'plan-ready' : 'demo');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${view} overflow at ${width}`);
        assert.equal(await page.getByRole('alert').count(), 0, `${view} errors at ${width}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await go('project', 'empty'); await button('暂停自动推进').click();
    await button('添加项目').click(); await page.getByLabel('项目目录', { exact: true }).selectOption('/mock/new-product'); await button('打开项目').click();
    await page.getByText('读取中', { exact: true }).waitFor(); await tick(2); await page.getByText('已就绪', { exact: true }).waitFor();
    await page.getByLabel('需求描述', { exact: true }).fill('增加项目搜索功能及边界验证'); await button('提交需求').click(); await page.getByText('REQ-001', { exact: false }).waitFor();
    await button('Plan').click(); await button('生成计划').click(); await page.getByText('Plan · 生成中', { exact: true }).waitFor(); await tick(2);
    await page.getByLabel('任务标题 1', { exact: true }).fill('确认搜索范围和验收条件'); await button('保存计划').click(); await page.getByText('请先保存修改', { exact: true }).waitFor({ state: 'hidden' });
    await button('确认计划').click(); await button('启动 Run').click(); await button('Run').click(); await button('暂停调度').waitFor(); await tick(8);
    await page.getByText('需要你的决策', { exact: true }).waitFor(); await button('决策').click(); await page.getByLabel('复审人', { exact: true }).fill('UI 验收'); await button('批准并应用').click();
    await page.locator('.detail-pane').getByText('已复审', { exact: true }).waitFor(); await button('Run').click(); await tick(40); await button('暂停调度').waitFor({ state: 'hidden' });
    await page.screenshot({ path: '/tmp/cc-mock-run.png', fullPage: true });
    await go('run', 'waiting'); await button('检查原因后重试').click(); await page.locator('.pending-card').waitFor({ state: 'hidden' });
    await go('run', 'waiting-text'); await page.getByLabel('消息', { exact: true }).fill('所有操作都有成功和失败反馈'); await button('发送').click(); await page.locator('.pending-card').waitFor({ state: 'hidden' });
    await go('run', 'failed'); await button('重试运行').click(); await button('取消运行').waitFor(); await button('取消运行').click(); await button('重试运行').waitFor();
    await go('tasks', 'blocked'); await page.locator('.record-card').filter({ hasText: 'T-08' }).click(); await button('解除阻塞').click(); await button('解除阻塞').waitFor({ state: 'hidden' });
    await go('decisions'); await button('采纳决策').click(); await page.locator('.detail-pane').getByText('已复审', { exact: true }).waitFor();
    await page.getByLabel('复审说明', { exact: true }).fill('增加边界验证'); await button('提交其他决策').click(); await page.locator('.detail-pane').getByText('已调整', { exact: true }).waitFor();
    await go('reviews', 'conflict'); await page.getByLabel('复审人', { exact: true }).fill('浏览器验证'); await button('批准并应用').click(); await button('重新校验提案').waitFor(); await button('重新校验提案').click(); await button('批准并应用').click(); await page.locator('.detail-pane').getByText('已应用', { exact: true }).waitFor();
    await page.locator('.record-card').filter({ hasText: 'P-003' }).click(); await page.getByLabel('复审人', { exact: true }).fill('验收'); await button('完成复审').click(); await button('完成复审').waitFor({ state: 'hidden' });
    await go('run'); await page.getByLabel('会话展示', { exact: true }).selectOption('original'); await page.getByText('来源：', { exact: false }).waitFor(); assert.ok((await page.locator('.terminal').textContent()).includes('D-mtvwylry-1'));
    await go('logs'); await page.getByLabel('搜索日志', { exact: true }).fill('NO_SUCH_EVENT'); await page.getByText('暂无输出', { exact: true }).waitFor(); await page.getByLabel('搜索日志', { exact: true }).fill(''); await button('清屏').click();
    await page.setViewportSize({ width: 390, height: 844 }); await go('project', 'empty'); await page.locator('.topbar button').click(); await button('添加项目').click(); await page.getByLabel('项目目录', { exact: true }).waitFor(); await page.screenshot({ path: '/tmp/cc-mock-empty-mobile.png', fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await button('取消').click();
    await go('run', 'error'); await page.getByRole('alert').first().waitFor(); await button('MOCK · 预览控制').click(); await button('恢复接口').click(); await page.getByRole('alert').first().waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []); assert.deepEqual(apiRequests, [], 'mock must never issue real API requests');
    console.log('PASS: 7 views × 4 widths; full empty-to-completion journey; text/choice/retry/cancel/unblock/adopt/override/conflict/review/raw-log/search/empty/error; zero live API requests');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
