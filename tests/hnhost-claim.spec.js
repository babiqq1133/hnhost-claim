// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SESSION_ID = process.env.SESSION_ID;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

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

// TG 推送函数（必须保留完整）
async function sendTGReport(page, status, points = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) {
        console.log('⚠️ TG_BOT 未配置，跳过推送');
        return;
    }

    const photoPath = `hnhost_claim_${Date.now()}.png`;
    try {
        if (!page.isClosed()) {
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

        const authUrl = "https://discord.com/login?redirect_to=%2Foauth2%2Fauthorize%3Fscope%3Dguilds%2Bguilds.join%2Bidentify%2Bemail%26client_id%3D933437142254887052%26redirect_uri%3Dhttps%253A%252F%252Fclient.hnhost.net%252Flogin%26response_type%3Dcode%26prompt%3Dnone";

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        await handleCloudflare(page);
        await page.waitForTimeout(8000);

        // Token 注入
        await page.evaluate((token) => {
            const timer = setInterval(() => {
                try {
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.token = `"${token}"`;
                    localStorage.setItem('token', `"${token}"`);
                } catch (e) {}
            }, 50);
            setTimeout(() => {
                clearInterval(timer);
                location.reload();
            }, 4000);
        }, DISCORD_TOKEN);

        await page.waitForTimeout(15000);

        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        await handleCloudflare(page);
        await page.waitForTimeout(5000);

        console.log('🔍 检测领取奖励按钮...');

        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励, button:has-text("领取")').first();

        if (await claimButton.isVisible({ timeout: 15000 }).catch(() => false)) {
            await claimButton.scrollIntoViewIfNeeded();
            console.log('🎁 点击领取奖励...');
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=获得|成功|HN Points|HNRC|金币').first().innerText().catch(() => '+10 HN Points');
            status = `领取成功 ${points}`;
            console.log('🏆 ' + status);
        } else {
            status = '未找到领取奖励按钮（可能今日已领取或登录失败）';
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
