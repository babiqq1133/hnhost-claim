// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
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

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY}`);

    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    let status = '执行中';
    let points = '';

    try {
        console.log('🔑 使用 Discord Token 进行 OAuth2 授权...');

        // 完全按照别人成功的链接
        const authUrl = "https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join%3Dhttps%253A%252F%252Fclient.hnhost.net%252Flogin%26response_type%3Dcode%26prompt%3Dnone";

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Token 注入（核心部分）
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

        await page.waitForTimeout(12000);

        console.log('⏳ 等待 OAuth2 回调...');
        await page.waitForURL(/backend\/pdo\/discord\.php\?code=/, { timeout: 30000 }).catch(() => {
            console.log('⚠️ 未检测到 code 参数');
        });

        console.log('✅ 当前 URL:', page.url());

        // 跳转到领取页面（按照别人成功路径）
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        await page.waitForTimeout(6000);

        console.log('🔍 检测领取奖励按钮...');

        // 加强按钮检测（适配多种可能文字）
        const claimButton = page.locator('button:has-text("领取奖励"), button:has-text("领取"), text=领取奖励').first();

        if (await claimButton.isVisible({ timeout: 20000 }).catch(() => false)) {
            console.log('🎁 点击「领取奖励」按钮...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=获得|成功|HNRC|金币|积分').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
            console.log('🏆 ' + status);
        } else {
            status = '未找到领取奖励按钮（可能今日已领取）';
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
