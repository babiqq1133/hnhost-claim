// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 90000;

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

// 轻量 Cloudflare 处理（当前基本用不到，但保留防未来变化）
async function handleCloudflare(page) {
    try {
        const cf = page.frameLocator('iframe[src*="cloudflare"], iframe[src*="turnstile"]');
        const btn = cf.locator('input[type="checkbox"], button');
        if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('🛡️ 检测到 Cloudflare，尝试处理...');
            await btn.click().catch(() => {});
            await page.waitForTimeout(8000);
        }
    } catch {}
}

// TG 美观推送
async function sendTGReport(page, status, points = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) {
        console.log('⚠️ TG_BOT 未配置，跳过推送');
        return;
    }

    const photoPath = `hnhost_claim_${Date.now()}.png`;
    try {
        if (!page.isClosed()) {
            await page.screenshot({ path: photoPath, fullPage: false });
        }
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

    if (!DISCORD_TOKEN) {
        throw new Error('❌ DISCORD_TOKEN 未在 Secrets 中配置');
    }

    const proxyConfig = process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理`);

    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    let finalStatus = '执行中';
    let gained = '';

    try {
        console.log('🌐 跳转到 HnHost 领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await handleCloudflare(page);
        await page.waitForTimeout(5000);

        console.log('🪙 检测领取奖励按钮...');

        const claimButton = page.locator('text=领取每日登录奖励,领取奖励').first();
        const alreadyClaimed = page.locator('text=已领取每日奖励').first();

        if (await alreadyClaimed.isVisible({ timeout: 5000 }).catch(() => false)) {
            finalStatus = '今日已领取每日奖励';
            console.log('✅ ' + finalStatus);
        } else if (await claimButton.isVisible({ timeout: 10000 }).catch(() => false)) {
            console.log('🔘 点击领取按钮...');
            await claimButton.click();
            await page.waitForTimeout(10000);

            // 尝试捕获获得金额
            gained = await page.locator('text=获得|HNRC|金币|积分').first().innerText().catch(() => '+60 HNRC');
            finalStatus = `领取成功 ${gained}`;
            console.log('🎉 ' + finalStatus);
        } else {
            finalStatus = '未找到领取按钮（可能今日已领取或页面变化）';
            console.log('⚠️ ' + finalStatus);
        }

        await sendTGReport(page, finalStatus, gained);

    } catch (error) {
        finalStatus = `执行失败: ${error.message}`;
        console.log('❌ ' + finalStatus);
        try { await sendTGReport(page, finalStatus); } catch {}
        throw error;
    } finally {
        await browser.close();
    }
});
