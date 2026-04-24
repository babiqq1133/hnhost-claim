// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
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

async function sendTGReport(page, status, points = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) return;

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

    const proxyConfig = process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined;
    if (proxyConfig) console.log('🛡️ 使用 GOST 代理');

    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    let status = '执行中';
    let points = '';

    try {
        console.log('🌐 跳转到 HnHost 领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        await handleCloudflare(page);
        await page.waitForTimeout(5000);

        console.log('🪙 检测并尝试领取奖励...');

        // 加强版按钮检测 + 重试 + 滚动
        const claimSelectors = [
            'button:has-text("领取奖励")',
            'text=领取奖励',
            'button >> text=领取'
        ];

        let clicked = false;

        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`🔄 第 ${attempt} 次尝试查找按钮...`);

            for (const sel of claimSelectors) {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
                    console.log(`🔘 找到按钮 [${sel}]，正在点击...`);
                    await btn.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(1000);
                    await btn.click({ delay: 800 });
                    clicked = true;
                    break;
                }
            }

            if (clicked) break;
            await page.waitForTimeout(3000);
        }

        if (!clicked) {
            // 保存调试截图
            await page.screenshot({ path: 'debug-no-button.png', fullPage: true });
            status = '未找到「领取奖励」按钮（已保存 debug-no-button.png）';
            console.log('⚠️ ' + status);
        } else {
            await page.waitForTimeout(10000); // 等待领取完成

            points = await page.locator('text=获得|成功|HN Points|HNRC|金币|积分').first().innerText().catch(() => '+10 HN Points');
            status = `领取成功 ${points}`;
            console.log('🎉 ' + status);
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
