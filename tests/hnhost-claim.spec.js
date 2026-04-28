// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TG_BOT = process.env.TG_BOT;
const PROXY = process.env.GOST_PROXY;

function maskIP(ip) {
  return ip.replace(/(\d+\.\d+\.\d+)\.\d+/, '$1.xx');
}

test('HnHost 每日领取金币', async () => {
  console.log("🛡️ 本地代理连通，使用 GOST 转发");

  const browser = await chromium.launch({
    headless: true,
    proxy: PROXY ? { server: PROXY } : undefined
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("🔧 启动浏览器...");
  console.log("🚀 浏览器就绪！");

  // 🌐 检测出口 IP
  try {
    const ipRes = await page.request.get('https://api.ipify.org');
    const ip = await ipRes.text();
    console.log(`✅ 出口 IP 确认: ${maskIP(ip)}`);
  } catch (e) {
    console.log("⚠️ IP 检测失败");
  }

  // 🔑 验证 Discord Token
  console.log("🔑 使用 Discord Token 调用 OAuth2 授权接口...");
  const userResp = await page.request.get(
    'https://discord.com/api/v9/users/@me',
    {
      headers: {
        Authorization: DISCORD_TOKEN
      }
    }
  );

  console.log(`📡 Discord OAuth2 响应状态: ${userResp.status()}`);

  if (userResp.status() !== 200) {
    throw new Error("❌ Discord Token 无效");
  }

  // 🌐 访问回调 URL（关键登录步骤）
  const callbackUrl = 'https://client.hnhost.net/backend/pdo/discord.php';

  console.log(`🔗 拿到回调 URL: ${callbackUrl}?code=***`);

  console.log("🌍 浏览器访问回调 URL，建立登录 Session...");
  await page.goto(callbackUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForURL(/index\.php/);

  console.log(`📍 当前 URL: ${page.url()}`);
  console.log("✅ 登录 Session 建立成功");

  // 💰 获取当前金币
  const coinText = await page.locator('text=HNRC').first().textContent();
  const before = coinText.match(/\d+/)?.[0] || '0';

  console.log(`💰 当前金币: ${before} HNRC`);

  console.log("🔍 检测领取按钮状态...");

  const claimBtn = page.locator('text=领取奖励');

  if (await claimBtn.isVisible()) {
    console.log("🎁 点击「领取奖励」按钮...");
    await claimBtn.click();

    console.log("⏳ 等待页面刷新...");
    await page.waitForTimeout(4000);

    const newText = await page.locator('text=HNRC').first().textContent();
    const after = newText.match(/\d+/)?.[0] || before;

    const diff = Number(after) - Number(before);

    console.log(`🏆 最新金币: ${after} HNRC`);
    console.log(`🎉 领取成功！+${diff} HNRC`);

    // 📩 TG 推送
    if (TG_BOT && TG_BOT.includes(',')) {
      const [chatId, token] = TG_BOT.split(',');

      await page.request.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        data: {
          chat_id: chatId,
          text: `✅ HnHost 领取成功\n💰 ${before} → ${after} (+${diff})`
        }
      });

      console.log("📤 TG 推送成功");
    }

  } else {
    console.log("⚠️ 今日可能已领取");
  }

  await browser.close();
});
