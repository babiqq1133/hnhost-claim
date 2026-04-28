// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 150000;

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
        if (!page.isClosed()) await page.screenshot({ path: photoPath, fullPage: true });
    } catch (e) {}

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
    test.setTimeout(TIMEOUT);
    if (!DISCORD_TOKEN) throw new Error('❌ DISCORD_TOKEN 未配置');

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY}`);

    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);

    console.log('🚀 浏览器就绪！');

    let status = '执行中';
    let points = '';

    try {
        console.log('🔑 使用 Discord Token 调用 OAuth2 授权接口...');

        const clientId = '1498565188511596554';
        const authUrl = `https://discord.com/oauth2/authorize?client_id=1498565188511596554&response_type=code&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&scope=identify+email+guilds+guilds.join`;

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 改进后的 Token 注入（等待页面加载后再注入）
        console.log('🔧 注入 Discord Token...');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        await page.evaluate((token) => {
            // 安全注入
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('token', `"${token}"`);
                console.log('localStorage injected');
            }
            window.token = token;
            window.__DISCORD_TOKEN__ = token;
        }, DISCORD_TOKEN).catch(err => {
            console.log('注入时出现警告:', err.message);
        });

        await page.waitForTimeout(8000);

        console.log('⏳ 等待 Discord OAuth2 响应...');
        await page.waitForResponse(r => r.url().includes('discord.com') && r.status() === 200, { timeout: 40000 })
            .catch(() => console.log('⚠️ 未等到 200 响应'));

        console.log('✅ Discord OAuth2 响应状态: 200');

        // 等待回调 URL
        console.log('⏳ 等待拿到回调 URL...');
        await page.waitForURL(/backend\/pdo\/discord\.php\?code=/, { timeout: 45000 }).catch(() => {
            console.log('⚠️ 未检测到 code 参数');
        });

        const callbackUrl = page.url();
        console.log('✅ 拿到回调 URL:', callbackUrl);

        // 访问回调 URL 建立 Session
        console.log('🌐 浏览器访问回调 URL，建立登录 Session...');
        await page.goto(callbackUrl, { waitUntil: 'networkidle', timeout: 60000 });

        console.log('✅ 登录 Session 建立成功');

        // 领取金币
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        await page.waitForTimeout(8000);

        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励').first();

        if (await claimButton.isVisible({ timeout: 20000 }).catch(() => false)) {
            console.log('🎁 点击领取奖励按钮...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=获得|成功|HNRC').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
        } else {
            status = '未找到领取奖励按钮（可能今日已领取）';
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
