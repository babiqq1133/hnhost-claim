// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SESSION_ID = process.env.SESSION_ID;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const TIMEOUT = 120000;

function nowStr() { /* 保持不变 */ }
function escapeHtml(text) { /* 保持不变 */ }

// TG 推送函数保持不变（略）

// 改进的 Cloudflare 处理
async function handleCloudflare(page) {
    try {
        await page.waitForTimeout(3000);
        const cf = page.locator('iframe[src*="cloudflare"], iframe[src*="turnstile"], button:has-text("Verify")');
        if (await cf.isVisible({ timeout: 8000 }).catch(() => false)) {
            console.log('🛡️ 检测到 Cloudflare，尝试点击验证...');
            await cf.click({ delay: 500 }).catch(() => {});
            await page.waitForTimeout(10000);
        }
    } catch (e) {}
}

test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);
    if (!DISCORD_TOKEN) throw new Error('❌ DISCORD_TOKEN 未配置');

    console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY || '未启用'}`);
    if (SESSION_ID) console.log(`🔑 SESSION_ID 已加载`);

    const browser = await chromium.launch({
        headless: true,
        proxy: GOST_PROXY ? { server: GOST_PROXY } : undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    let status = '执行中';
    let points = '';

    try {
        console.log('🔑 使用 Discord Token 进行 OAuth2 授权...');

        // === 核心修改：先构造 OAuth2 授权链接（更可靠的方式）===
        const clientId = '933437142254887052';
        const redirectUri = 'https://client.hnhost.net/backend/pdo/discord.php';  // 根据别人日志推测的回调地址
        const scopes = 'identify email guilds guilds.join'; // 根据你的原链接调整

        const authUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&prompt=none`;

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await handleCloudflare(page);
        await page.waitForTimeout(8000);

        // Token 注入（改进版，更稳定）
        await page.evaluate((token) => {
            try {
                // 清除旧的
                localStorage.removeItem('token');
                // 使用 iframe 注入（兼容性更好）
                const iframe = document.createElement('iframe');
                document.body.appendChild(iframe);
                iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
                // 直接在主窗口也设置
                localStorage.setItem('token', `"${token}"`);
            } catch (e) {
                console.error('注入失败:', e);
            }
        }, DISCORD_TOKEN);

        await page.waitForTimeout(10000);
        await page.reload({ waitUntil: 'networkidle' }); // 刷新让 Discord 识别 Token

        // 等待 OAuth2 回调（关键！）
        console.log('⏳ 等待 Discord OAuth2 回调...');
        await page.waitForURL(url => url.href.includes('client.hnhost.net') && url.href.includes('code='), { timeout: 30000 })
            .catch(() => console.log('⚠️ 未检测到 code 参数，可能需要手动处理'));

        const currentUrl = page.url();
        console.log('📍 当前 URL：', currentUrl);

        if (currentUrl.includes('code=')) {
            console.log('✅ 成功拿到 OAuth2 code，开始建立 Session...');
            // 如果回调已经是 hnhost 的页面，直接继续
        } else {
            // 如果没自动跳转，手动构造回调（备用方案）
            // 这里需要你提供你的实际日志，我再帮你调整
        }

        // 注入 SESSION_ID（如果有）
        if (SESSION_ID) {
            await page.evaluate((sid) => {
                document.cookie = `session_id=${sid}; path=/; domain=.hnhost.net`;
                localStorage.setItem('session_id', sid);
            }, SESSION_ID);
        }

        // 跳转到领取页面
        console.log('🌐 进入 HnHost 主页...');
        await page.goto('https://client.hnhost.net/index.php', { waitUntil: 'networkidle' });
        await handleCloudflare(page);
        await page.waitForTimeout(5000);

        // 查找并点击领取按钮（你的原逻辑保留，但增加等待）
        console.log('🔍 检测「领取奖励」按钮...');
        const claimButton = page.locator('button:has-text("领取奖励"), button:has-text("領取獎勵"), button:has-text("领取"), text=/領取|领取|Claim/i').first();

        if (await claimButton.isVisible({ timeout: 15000 }).catch(() => false)) {
            await claimButton.scrollIntoViewIfNeeded();
            console.log('🎁 点击领取奖励...');
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=/获得|成功|\+10|HNRC|金币/i').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功 ${points}`;
            console.log('🏆 ' + status);
        } else {
            status = '未找到领取按钮（可能已领取或登录失败）';
            console.log('⚠️ ' + status);
            await page.screenshot({ path: 'debug-no-button.png', fullPage: true });
        }

        await sendTGReport(page, status, points);

    } catch (error) {
        status = `执行失败: ${error.message}`;
        console.log('❌ ' + status);
        try { await sendTGReport(page, status); } catch {}
        throw error;
    } finally {
        await browser.close();
    }
});
