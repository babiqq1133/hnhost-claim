// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

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
    try { if (!page.isClosed()) await page.screenshot({ path: photoPath, fullPage: true }); } catch (e) {}

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
        const req = https.request({ method: 'POST', host: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendPhoto`, headers: form.getHeaders() }, (res) => {
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
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);

    console.log('🚀 浏览器就绪！');

    let status = '执行中';
    let points = '';

    try {
        const clientId = '1497635385562628296';
        const state = Math.random().toString(36).substring(2, 15);

        const authUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join&state=${state}&prompt=consent`;

        console.log('🔑 打开 Discord OAuth2 授权页面...');
        await page.goto(authUrl, { waitUntil: 'networkidle', timeout: 80000 });

        console.log('🔧 注入 Discord Token...');
        await page.evaluate((token) => {
            try {
                localStorage.setItem('token', `"${token}"`);
                window.token = token;
            } catch (e) {}
        }, DISCORD_TOKEN);

        await page.waitForTimeout(10000);

        console.log('⏳ 尝试点击「授权」按钮...');
        for (let i = 0; i < 5; i++) {
            try {
                const btn = page.locator('button:has-text("授权"), button:has-text("Authorize"), text=/授权/i').first();
                if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
                    console.log(`🔘 点击授权按钮 (第 ${i+1} 次)`);
                    await btn.click({ delay: 1000 });
                    await page.waitForTimeout(8000);
                }
            } catch (e) {}
        }

        // 提取 code
        console.log('⏳ 提取 code 参数...');
        let code = null;
        let currentUrl = page.url();
        console.log('📍 当前 URL:', currentUrl);

        for (let i = 0; i < 6 && !code; i++) {
            try {
                const urlObj = new URL(currentUrl);
                code = urlObj.searchParams.get('code');
            } catch (e) {}

            if (!code) {
                await page.waitForTimeout(5000);
                currentUrl = page.url();
                console.log(`📍 第 ${i+1} 次检查 URL:`, currentUrl);
            }
        }

        if (!code) {
            await page.screenshot({ path: 'debug-no-code.png', fullPage: true });
            throw new Error('未能获取 OAuth code。请确认 Redirect URI 已保存且生效。');
        }

        console.log(`✅ 成功获取 code！长度: ${code.length}`);

        // 领取金币
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', { waitUntil: 'networkidle', timeout: 60000 });

        await page.waitForTimeout(8000);

        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励').first();

        if (await claimButton.isVisible({ timeout: 25000 }).catch(() => false)) {
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
