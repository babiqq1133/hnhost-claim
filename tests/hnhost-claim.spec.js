// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TEST_TIMEOUT = 240000; // 4分钟

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
    } catch (e) {}

    const report = [
        `🪙 <b>HnHost 每日领取金币报告</b>`,
        `━━━━━━━━━━━━━━━━━━`,
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

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY}`);

    if (!fs.existsSync('storageState.json')) {
        console.log('❌ 未找到 storageState.json 文件！');
        console.log('⚠️ 请在本地电脑上运行以下命令手动登录并保存状态：');
        console.log('   node tests/save-discord-login.js');
        console.log('保存成功后，把生成的 storageState.json 文件上传到仓库。');
        throw new Error('缺少 storageState.json，请先手动登录保存状态');
    }

    let browser, context;
    let status = '执行中';
    let points = '';

    try {
        console.log('🚀 找到 storageState.json，正在启动浏览器...');

        browser = await chromium.launch({ 
            headless: true,
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
        });

        context = await browser.newContext({
            storageState: 'storageState.json',
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        });

        const page = await context.newPage();
        page.setDefaultTimeout(90000);

        console.log('✅ 登录状态加载成功！');

        // 跳转领取页面
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        await page.mouse.move(300 + Math.random() * 500, 200 + Math.random() * 300, { steps: 10 });
        await page.waitForTimeout(3000);

        console.log('🔍 查找领取奖励按钮...');
        const claimButton = page.locator('button').filter({ hasText: /领取奖励|Claim|领取/ }).first();

        const isVisible = await claimButton.isVisible({ timeout: 20000 }).catch(() => false);

        if (isVisible) {
            console.log('🎁 点击领取...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=/获得|成功|HNRC|金币/i').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
        } else {
            status = '未找到领取奖励按钮（可能今日已领取 或 Cloudflare 拦截）';
        }

        await sendTGReport(page, status, points);
        console.log(`✅ ${status}`);

    } catch (error) {
        status = `执行失败: ${error.message}`;
        console.error('❌', status);
        try { await sendTGReport(page, status); } catch {}
        throw error;
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
});
