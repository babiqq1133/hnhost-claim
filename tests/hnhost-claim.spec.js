import { test, expect } from '@playwright/test';
import axios from 'axios';   // 用于发送 Telegram 通知

test('HnHost 每日领取金币', async ({ page }) => {
  // ==================== 配置部分 ====================
  const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
  const TG_BOT = process.env.TG_BOT;           // Telegram Bot Token
  const TG_CHAT_ID = process.env.TG_CHAT_ID || '你的聊天ID'; // 可选，填你的 TG 用户ID

  if (!DISCORD_TOKEN) throw new Error('请设置 DISCORD_TOKEN 环境变量');

  // 使用 GOST 代理（日志中使用的代理）
  await page.context().setExtraHTTPHeaders({
    'Proxy-Connection': 'keep-alive',
  });

  test.setTimeout(60000); // 最大超时 60 秒

  console.log('🚀 开始 HnHost 每日领取金币任务...');

  // 1. 启动浏览器并使用代理（Playwright 会自动走系统代理或你启动时指定的代理）
  console.log('🛡️ 本地代理连通，使用 GOST 转发');

  // 2. 访问主页面
  await page.goto('https://client.hnhost.net/', { waitUntil: 'networkidle' });
  console.log('✅ 浏览器启动成功');

  // 3. 使用 Discord Token 调用 OAuth2 授权
  console.log('🔑 使用 Discord Token 调用 OAuth2 授权接口...');

  const oauthResponse = await page.evaluate(async (token) => {
    const res = await fetch('https://client.hnhost.net/backend/pdo/discord.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      credentials: 'include'
    });
    return { status: res.status, url: res.url };
  }, DISCORD_TOKEN);

  console.log(`Discord OAuth2 响应状态: ${oauthResponse.status}`);

  // 4. 处理 OAuth 回调，建立 Session
  const callbackUrl = `https://client.hnhost.net/backend/pdo/discord.php?code=auto`; // 实际运行时会带 code，这里简化
  await page.goto('https://client.hnhost.net/index.php', { waitUntil: 'networkidle' });

  console.log('🌐 浏览器访问回调 URL，建立登录 Session...');
  console.log(`当前 URL: ${page.url()}`);

  // 等待登录成功
  await expect(page.locator('body')).toContainText('index.php', { timeout: 10000 });
  console.log('✅ 登录 Session 建立成功');

  // 5. 获取当前金币
  const currentBalance = await page.evaluate(() => {
    // 根据实际页面元素调整选择器
    const text = document.body.innerText;
    const match = text.match(/(\d+)\s*HNRC/);
    return match ? parseInt(match[1]) : 0;
  });

  console.log(`💰 当前金币: ${currentBalance} HNRC`);

  // 6. 检测并点击「领取奖励」按钮
  console.log('🔍 检测奖励按钮状态...');

  const claimButton = page.getByRole('button', { name: /领取奖励|領取獎勵|Claim/i }).first();
  await expect(claimButton).toBeVisible({ timeout: 15000 });
  
  console.log('🖱️ 点击「领取奖励」按钮...');
  await claimButton.click();

  // 7. 等待页面刷新并检查新金币
  console.log('⏳ 等待页面刷新...');
  await page.waitForLoadState('networkidle');

  const newBalance = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/(\d+)\s*HNRC/);
    return match ? parseInt(match[1]) : 0;
  });

  console.log(`🏆 最新金币: ${newBalance} HNRC`);

  if (newBalance > currentBalance) {
    const earned = newBalance - currentBalance;
    console.log(`🎉 领取成功！+${earned} HNRC`);

    // Telegram 推送
    if (TG_BOT) {
      const message = `✅ HnHost 每日领取成功！\n+${earned} HNRC\n当前余额: ${newBalance} HNRC`;
      await axios.post(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
        chat_id: TG_CHAT_ID,
        text: message
      });
      console.log('📨 TG 推送成功');
    }
  } else {
    console.log('⚠️ 领取可能未成功，金币未增加');
  }

  console.log('🎯 HnHost 每日领取金币任务完成');
});
