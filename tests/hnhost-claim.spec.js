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

// Cloudflare 处理
async function handleCloudflare(page) {
    try {
        const cf = page.frameLocator('iframe[src*="cloudflare"], iframe[src*="turnstile"]');
        const btn = cf.locator('input[type="checkbox"], button');
        if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('🛡️ 检测到 Cloudflare，尝试穿透...');
            await btn.click().catch(() => {});
            await page.waitForTimeout(8000);
        }
    } catch {}
}

// TG 报告推送
async function sendTGReport(page, status, points = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) {
        console.log('⚠️ TG_BOT 未配置');
        return;
    }

    const photoPath = `hnhost_claim_${Date.now()}.png`;
    try {
        if (!page.isClosed()) await page.screenshot({ path: photoPath, fullPage: true });
    } catch {}

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

    console.log(`🛡️ GOST_PROXY: ${GOST_PROXY ? '已启用' : '未使用'}`);
    if (SESSION_ID) console.log(`🔑 SESSION_ID 已加载`);

    const browser = await chromium.launch({
        headless: true,
        proxy: GOST_PROXY ? { server: GOST_PROXY } : undefined
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    let status = '执行中';
    let points = '';

    try {
        console.log('🔑 开始登录 HnHost...');

        const loginUrl = "https://discord.com/login?redirect_to=%2Foauth2%2Fauthorize%3Fscope%3Dguilds%2Bguilds.join%2Bidentify%2Bemail%26client_id%3D933437142254887052%26redirect_uri%3Dhttps%253A%252F%252Fclient.hnhost.net%252Flogin%26response_type%3Dcode%26prompt%3Dnone";

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        await handleCloudflare(page);
        await page.waitForTimeout(8000);

        // Discord Token 注入
        await page.evaluate((token) => {
            const timer = setInterval(() => {
                try {
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.token = `"${token}"`;
                } catch (e) {}
            }, 50);
            setTimeout(() => {
                clearInterval(timer);
                location.reload();
            }, 4000);
        }, DISCORD_TOKEN);

        await page.waitForTimeout(15000);

        // 如果有 SESSION_ID，尝试注入
        if (SESSION_ID) {
            console.log('🔑 注入 SESSION_ID...');
            await page.evaluate((sid) => {
                document.cookie = `session_id=${sid}; path=/`;
                localStorage.setItem('session_id', sid);
            }, SESSION_ID);
            await page.waitForTimeout(3000);
        }

        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        await handleCloudflare(page);
        await page.waitForTimeout(5000);

        console.log('🪙 查找「领取奖励」按钮...');

        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励, button:has-text("领取")').first();

        if (await claimButton.isVisible({ timeout: 15000 }).catch(() => false)) {
            console.log('🔘 点击领取奖励按钮...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 800 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=获得|成功|HN Points|HNRC|金币|积分').first().innerText().catch(() => '+10 HN Points');
            status = `领取成功 ${points}`;
            console.log('🎉 ' + status);
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
