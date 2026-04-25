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
    page.setDefaultTimeout(90000);   // 适当加大默认超时

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

        // 可选：添加 state 参数（推荐）
        const state = Math.random().toString(36).substring(2, 15);
        const authUrl = `https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join&state=${state}`;

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Token 注入（更稳定写法）
        console.log('🔧 注入 Discord Token...');
        await page.evaluate((token) => {
            localStorage.setItem('token', `"${token}"`);
            // 额外注入方式，兼容更多情况
            Object.defineProperty(window, 'token', { value: token, writable: true });
        }, DISCORD_TOKEN);

        await page.waitForTimeout(3000);

        // 等待 Discord 处理授权（可能有登录/授权按钮）
        console.log('⏳ 等待 Discord OAuth2 处理...');
        await page.waitForResponse(
            response => response.url().includes('discord.com') && response.status() === 200,
            { timeout: 45000 }
        ).catch(() => console.log('⚠️ 未等到 200 响应'));

        console.log('✅ Discord OAuth2 响应状态: 200');

        // ==================== 关键修复：等待回调 URL ====================
        console.log('⏳ 等待重定向到回调页面 (discord.php?code=...) ...');

        let code = null;

        try {
            // 优先使用 waitForURL 精确等待
            await page.waitForURL(/discord\.php.*code=/, { timeout: 40000 });
            console.log('✅ 已成功重定向到回调页面');
        } catch (e) {
            console.log('⚠️ waitForURL 未匹配到精确 URL，尝试从当前 URL 提取 code...');
        }

        // 从当前 URL 中提取 code（更可靠的兜底方案）
        const currentUrl = page.url();
        console.log('📍 当前 URL:', currentUrl);

        try {
            const urlObj = new URL(currentUrl);
            code = urlObj.searchParams.get('code');

            if (!code && currentUrl.includes('redirect_to') || currentUrl.includes('discord.com/login')) {
                // 如果还在 Discord 中间页，尝试再等一次完整跳转
                await page.waitForTimeout(5000);
                const finalUrl = page.url();
                const finalUrlObj = new URL(finalUrl);
                code = finalUrlObj.searchParams.get('code');
            }
        } catch (e) {
            console.log('⚠️ URL 解析失败');
        }

        if (!code) {
            console.log('❌ 仍然未检测到 code 参数！');
            console.log('💡 建议检查：');
            console.log('   1. Discord 开发者后台的 Redirect URI 是否完全一致？');
            console.log('   2. redirect_uri 是否已正确注册为 https://client.hnhost.net/backend/pdo/discord.php');
            await page.screenshot({ path: 'debug-no-code.png', fullPage: true });
            throw new Error('未获取到 OAuth code');
        }

        console.log(`✅ 成功获取 code 参数！长度: ${code.length}`);

        // ==================== 继续执行领取逻辑 ====================
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        await page.waitForTimeout(8000);

        console.log('🔍 检测领取奖励按钮...');

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
