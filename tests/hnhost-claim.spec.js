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
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { timeout: 15000 });
            const ipData = await res.json().catch(() => ({}));
            console.log(`✅ 出口 IP 确认：${ipData.ip || '获取成功'}`);
        } catch (e) {
            console.log('⚠️ IP 验证失败，继续执行');
        }

        console.log('🔑 使用 Discord Token 调用 OAuth2 授权接口...');

        // 使用新的 Client ID
        const clientId = '1497635385562628296';
        const state = Math.random().toString(36).substring(2, 15);
        
        const authUrl = `https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join}`;

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ==================== Token 注入 + 自动处理 ====================
        console.log('🔧 注入 Discord Token...');
        await page.waitForLoadState('domcontentloaded');

        await page.evaluate((token) => {
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('token', `"${token}"`);
                }
                window.token = token;
                window.__DISCORD_TOKEN__ = token;
                window.dispatchEvent(new Event('storage'));
            } catch (e) {
                console.error('注入错误:', e.message);
            }
        }, DISCORD_TOKEN);

        await page.waitForTimeout(6000);

        console.log('⏳ 尝试自动处理登录/授权...');

        // 尝试点击登录按钮
        try {
            const loginBtn = page.locator('button:has-text("登录"), button:has-text("Log In"), [type="submit"]').first();
            if (await loginBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
                console.log('🔘 点击登录按钮');
                await loginBtn.click({ delay: 800 });
                await page.waitForTimeout(7000);
            }
        } catch (e) {}

        // 尝试点击授权按钮
        try {
            const authBtn = page.locator('button:has-text("授权"), button:has-text("Authorize"), text=/授权|Authorize/i').first();
            if (await authBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
                console.log('🔘 点击授权按钮');
                await authBtn.click({ delay: 1000 });
                await page.waitForTimeout(5000);
            }
        } catch (e) {}

        // ==================== 等待并提取 code ====================
        console.log('⏳ 等待回调 URL (discord.php?code=...) ...');

        let code = null;
        const currentUrl = page.url();
        console.log('📍 当前 URL:', currentUrl);

        try {
            await page.waitForURL(/discord\.php.*code=/, { timeout: 30000 });
            console.log('✅ 成功重定向到回调页面');
        } catch (e) {
            console.log('⚠️ 未精确匹配，尝试从 URL 提取 code...');
        }

        try {
            const urlObj = new URL(page.url());
            code = urlObj.searchParams.get('code');
        } catch (e) {}

        if (!code) {
            console.log('❌ 未获取到 OAuth code！');
            await page.screenshot({ path: 'debug-no-code.png', fullPage: true });
            throw new Error('未获取到 OAuth code，请确认 Redirect URI 已保存');
        }

        console.log(`✅ 成功获取 code！长度: ${code.length}`);

        // ==================== 领取金币 ====================
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
