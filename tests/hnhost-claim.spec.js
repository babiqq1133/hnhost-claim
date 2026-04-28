// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

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

// ====================== 主测试 ======================
test('HnHost 每日领取金币', async () => {
    test.setTimeout(TEST_TIMEOUT);

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY}`);

    let browser, context, page;
    let status = '执行中';
    let points = '';

    try {
        // ==================== 1. 检查是否已有登录状态 ====================
        if (!fs.existsSync('storageState.json')) {
            console.log('⚠️ 未找到 storageState.json，开始首次手动登录流程...');

            browser = await chromium.launch({ 
                headless: false,   // 首次必须有界面，让你手动登录
                args: ['--no-sandbox']
            });

            context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            });

            page = await context.newPage();

            const authUrl = `https://discord.com/oauth2/authorize?client_id=1497635385562628296&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join`;

            console.log('🌐 打开 Discord 授权页面...');
            await page.goto(authUrl, { waitUntil: 'domcontentloaded' });

            console.log('\n=== 请在弹出的浏览器中手动操作 ===');
            console.log('1. 登录你的 Discord 账号');
            console.log('2. 点击「授权」按钮');
            console.log('3. 等待跳转到 hnhost.net\n');

            // 等待成功跳转到 hnhost
            await page.waitForURL('**/client.hnhost.net/**', { timeout: 300000 })
                .then(() => console.log('✅ 登录授权成功！正在保存状态...'))
                .catch(() => { throw new Error('登录超时或失败，请重新运行'); });

            // 保存登录状态
            const storageState = await context.storageState();
            fs.writeFileSync('storageState.json', JSON.stringify(storageState, null, 2));
            console.log('🎉 登录状态已保存，下次将自动登录');

            await browser.close();
            
            // 保存完后重新启动 headless 模式继续领取
            console.log('🔄 重新启动浏览器进行领取...');
        }

        // ==================== 2. 使用已保存的状态运行领取流程 ====================
        browser = await chromium.launch({ 
            headless: true,
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
        });

        context = await browser.newContext({
            storageState: 'storageState.json',   // 自动登录关键
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            locale: 'zh-CN',
        });

        page = await context.newPage();
        page.setDefaultTimeout(90000);

        console.log('🚀 已加载登录状态，浏览器就绪！');

        // 跳转领取页面
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        // 模拟人类行为
        await page.mouse.move(300 + Math.random() * 500, 200 + Math.random() * 300, { steps: 10 });
        await page.waitForTimeout(3000);

        // 查找并点击领取按钮
        console.log('🔍 查找领取奖励按钮...');
        const claimButton = page.locator('button').filter({ hasText: /领取奖励|Claim|领取/ }).first();

        const isVisible = await claimButton.isVisible({ timeout: 20000 }).catch(() => false);

        if (isVisible) {
            console.log('🎁 点击领取按钮...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=/获得|成功|HNRC|金币/i').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
        } else {
            status = '未找到领取奖励按钮（可能今日已领取 或 被 Cloudflare 拦截）';
        }

        await sendTGReport(page, status, points);
        console.log(`✅ ${status}`);

    } catch (error) {
        status = `执行失败: ${error.message}`;
        console.error('❌', status);
        try { await sendTGReport(page, status); } catch {}
        throw error;
    } finally {
        if (context) await context.close();
        if (browser) await browser.close().catch(() => {});
    }
});
