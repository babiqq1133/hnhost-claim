// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TEST_TIMEOUT = 300000; // 5分钟

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\//g, '-');
}

function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function sendTGReport(page, status, points = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) return;

    const photoPath = `hnhost_claim_${Date.now()}.png`;
    try {
        if (page && !page.isClosed()) {
            await page.screenshot({ path: photoPath, fullPage: true });
        }
    } catch (e) {
        console.log('截图失败:', e.message);
    }

    const report = [
        `🪙 <b>HnHost 每日领取金币报告</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 账户：<b><code>${escapeHtml(DISCORD_TOKEN ? DISCORD_TOKEN.substring(0, 25) + '...' : 'N/A')}</code></b>`,
        `📊 状态：${escapeHtml(status)}`,
        points ? `💰 本次获得：${points}` : '',
        `🕒 北京时间：<b><code>${escapeHtml(nowStr())}</code></b>`,
        `━━━━━━━━━━━━━━━━━━`
    ].filter(Boolean).join('\n');

    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('caption', report);
    form.append('parse_mode', 'HTML');
    if (fs.existsSync(photoPath)) form.append('photo', fs.createReadStream(photoPath));

    return new Promise((resolve) => {
        const req = https.request({
            method: 'POST',
            host: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendPhoto`,
            headers: form.getHeaders(),
        }, (res) => {
            console.log(`📨 TG 推送状态: ${res.statusCode}`);
            if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
            resolve();
        });
        req.on('error', () => resolve());
        form.pipe(req);
    });
}

test('HnHost 每日领取金币', async () => {
    test.setTimeout(TEST_TIMEOUT);
    
    if (!DISCORD_TOKEN) {
        throw new Error('❌ DISCORD_TOKEN 未配置');
    }

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY}`);

    const browser = await chromium.launch({ 
        headless: true, 
        proxy: proxyConfig,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        bypassCSP: true,
        ignoreHTTPSErrors: true,
    });

    // 基础 stealth 设置
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US'] });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    console.log('🚀 浏览器就绪！');

    let status = '执行中';
    let points = '';

    try {
        const clientId = '1497635385562628296';
        const authUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join`;

        console.log('🔑 访问 Discord OAuth2 授权页面...');
        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ============ 加强版 Token 注入（关键修复） ============
        console.log('🔧 加强注入 Discord Token...');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(4000);

        await page.evaluate((token) => {
            function injectToken(t) {
                try {
                    // 主流注入方式
                    localStorage.setItem('token', JSON.stringify(t));
                    localStorage.setItem('user_token', JSON.stringify(t));
                    
                    // iframe 注入（Discord 常用绕过方式）
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.token = `"${t}"`;
                    
                    window.token = t;
                    window.__DISCORD_TOKEN__ = t;
                    window.__accessToken = t;
                    
                    console.log('✅ Token 注入完成');
                } catch (e) {
                    console.log('注入错误:', e.message);
                }
            }
            injectToken(token);
            
            // 多次注入 + 延迟
            setTimeout(() => injectToken(token), 1000);
        }, DISCORD_TOKEN);

        // 重要：给 Discord 足够时间验证 Token
        console.log('⏳ 等待 Discord 处理 Token（15-18秒）...');
        await page.waitForTimeout(18000);

        console.log('⏳ 等待回调 URL（包含 code）...');
        await page.waitForURL((url) => url.includes('client.hnhost.net') && url.includes('code='), 
            { timeout: 45000 }
        ).catch(() => {
            console.log('⚠️ 未检测到正确的 code 参数，当前URL:', page.url());
        });

        const callbackUrl = page.url();
        console.log('✅ 当前回调 URL:', callbackUrl);

        if (!callbackUrl.includes('code=')) {
            console.log('❌ Token 注入失败，仍停留在 Discord 登录页面');
        }

        // 建立 Session
        console.log('🌐 访问回调 URL 建立 Session...');
        await page.goto(callbackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log('✅ 登录 Session 建立成功');

        // ============ 领取页面 ============
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

        // 模拟人类行为
        await page.mouse.move(100, 200, { steps: 10 });
        await page.waitForTimeout(3000);

        console.log('🔍 查找领取奖励按钮...');
        const claimButton = page.locator('button').filter({ hasText: /领取奖励|Claim|领取/ }).first();

        const isVisible = await claimButton.isVisible({ timeout: 15000 }).catch(() => false);

        if (isVisible) {
            console.log('🎁 点击领取按钮...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 800 });

            await page.waitForTimeout(10000);
            points = await page.locator('text=/获得|成功|HNRC|金币/i').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
        } else {
            status = '未找到领取奖励按钮（可能今日已领取 或 被 Cloudflare 拦截）';
            console.log(status);
        }

        await sendTGReport(page, status, points);

    } catch (error) {
        status = `执行失败: ${error.message}`;
        console.error('❌', status);
        try { await sendTGReport(page, status); } catch {}
        throw error;
    } finally {
        await context.close();
        await browser.close().catch(() => {});
    }
});
